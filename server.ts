// ============================================================================
// SERVER.TS — Orquestrador Principal (Express + Firebase + Vite)
// Refatorado: Lógica extraída para src/services/
// ============================================================================
import express from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import dotenv from "dotenv";
import { initializeApp, getApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createServer as createViteServer } from "vite";
import fs from "fs";

// Importar serviços modulares
import {
  MAX_HISTORY_MESSAGES,
  MAX_SESSION_MESSAGES,
  MAX_MESSAGE_LENGTH,
  MESSAGE_TOO_LONG_RESPONSE,
  HANDOFF_MESSAGE,
  isEmergency,
  isSessionLimitReached,
} from "./src/services/guardrailService.ts";

import {
  loadFAQs,
  matchFAQ,
  retrieveRelevantContext,
} from "./src/services/ragService.ts";

import {
  sessionMessageCount,
  getOrCreateSessionState,
  updateSessionAfterResponse,
  tryExtractLeadName,
  tryExtractSessionVariables,
  buildStateInjection,
} from "./src/services/sessionService.ts";

import {
  initGeminiClient,
  callGeminiWithFallback,
  parseLyaResponse,
  buildLegacyText,
  transcribeAudio,
  generateSummary,
} from "./src/services/geminiService.ts";

// Importar o prompt cognitivo da Lya
import { systemInstruction } from "./bot_brain/system_prompt.ts";

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
dotenv.config();

// Firebase Admin
let projectId = "vittarecomunicacao";
let databaseId = "(default)";

try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (config.projectId) projectId = config.projectId;
    if (config.firestoreDatabaseId && config.firestoreDatabaseId !== "(default)") {
      databaseId = config.firestoreDatabaseId;
    }
  }
} catch (err) {
  console.error("Error reading firebase-applet-config.json:", err);
}

initializeApp({ projectId });

const db =
  databaseId && databaseId !== "(default)"
    ? getFirestore(getApp(), databaseId)
    : getFirestore(getApp());

// Gemini SDK
initGeminiClient(process.env.GEMINI_API_KEY);

// Carregar FAQs e Knowledge Base em memória
loadFAQs();

// ============================================================================
// EXPRESS APP
// ============================================================================
const app = express();
app.set("trust proxy", 1);
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Rate Limiter: máximo de 10 requisições por minuto por IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { error: "Muitas requisições. Aguarde um momento antes de enviar novas mensagens." },
});

app.use("/api/chat", apiLimiter);
app.use("/api/transcribe", apiLimiter);

// ============================================================================
// HELPERS
// ============================================================================

// In-memory set to prevent processing the same message twice
const processedMessageIds = new Set<string>();

/**
 * Formata mensagens para o Gemini API com suporte a multimodal (áudio/imagem inline)
 */
function formatMessagesForGemini(messages: any[]) {
  return messages.map((msg) => {
    const role = msg.sender === "user" ? "user" : "model";
    const text = msg.text || "";

    const mediaRegex = /\[MEDIA:\s*(data:([^;]+);base64,([^\]]+))\]/i;
    const match = text.match(mediaRegex);

    if (match) {
      const mimeType = match[2];
      const base64Data = match[3];
      const cleanText = text.replace(mediaRegex, "").trim();
      const mediaLabel = mimeType.startsWith("audio/")
        ? "Áudio gravado enviado pelo paciente"
        : "Imagem enviada pelo paciente";

      return {
        role,
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: cleanText || mediaLabel },
        ],
      };
    }

    return { role, parts: [{ text }] };
  });
}

// ============================================================================
// GERAÇÃO DE RESPOSTA IA (Chat Principal)
// ============================================================================

/**
 * Gera a resposta da Lya via Gemini com RAG + Session Memory + Structured Output
 */
async function generateAiResponse(sessionId: string, messages: any[]) {
  try {
    console.log(`Generating AI response for session: ${sessionId}`);

    // Sliding Window: enviar apenas as últimas N mensagens
    const prunedMessages = messages.slice(-MAX_HISTORY_MESSAGES);
    const contents = formatMessagesForGemini(prunedMessages);

    // Tentar extrair nome e variáveis de sessão da última mensagem do usuário
    const lastUserMsg = messages.slice().reverse().find((m) => m.sender === "user")?.text || "";
    tryExtractSessionVariables(sessionId, lastUserMsg);
    tryExtractLeadName(sessionId, lastUserMsg);

    // Montar instrução enriquecida: System Prompt + Session Memory + RAG
    const stateInjection = buildStateInjection(sessionId);
    const ragContext = retrieveRelevantContext(lastUserMsg);
    const enrichedInstruction = systemInstruction + stateInjection + ragContext;

    // Chamar Gemini com Structured Output
    const aiText = await callGeminiWithFallback({
      contents,
      systemInstruction: enrichedInstruction,
      useStructuredOutput: true,
    });

    // Parsear JSON estruturado
    const parsed = parseLyaResponse(aiText);

    // ========================================================================
    // DOUBLE-CHECK DE SEGURANÇA DETERMINÍSTICO (Lead Name Gateway Guard)
    // Avaliação de cenários e validação em memória interna/logs do sistema
    // ========================================================================
    const stateBefore = getOrCreateSessionState(sessionId);
    if (!stateBefore.leadName) {
      // Se a IA ainda não capturou o nome do lead e tentou gerar chips de Origem ou mídias
      const hasOriginChips = parsed.ui_chips?.some((c) =>
        c.toLowerCase().includes("redes") ||
        c.toLowerCase().includes("google") ||
        c.toLowerCase().includes("indica") ||
        c.toLowerCase().includes("mim") ||
        c.toLowerCase().includes("familiar")
      );

      const hasAskedForName =
        parsed.reply_text.toLowerCase().includes("como posso te chamar") ||
        parsed.reply_text.toLowerCase().includes("qual o seu nome") ||
        parsed.reply_text.toLowerCase().includes("qual é o seu nome") ||
        parsed.reply_text.toLowerCase().includes("seu nome");

      if (hasOriginChips || parsed.media_to_trigger || !hasAskedForName) {
        console.log(`[Double-Check System Log] Detectada tentativa de avanço de funil ou ausência de captura do nome para sessão ${sessionId}. Aplicando rota canônica segura.`);
        
        parsed.media_to_trigger = null;
        parsed.ui_chips = [];

        // Se o lead adiantou uma dor ou queixa clínica (ex: dores de cabeça)
        const complaint = stateBefore.detectedCondition || stateBefore.healthObjective;
        if (complaint && complaint !== "Em triagem inicial") {
          const formattedComplaint = complaint.toLowerCase().includes("dor")
            ? complaint.toLowerCase()
            : `essas queixas de ${complaint.toLowerCase()}`;
          
          parsed.reply_text = `Olá! Prazer receber você por aqui.\n\nSinto muito pelo incômodo com ${formattedComplaint} — o Dr. João Paulo atua exatamente investigando a causa raiz desses quadros para desenhar o cuidado mais assertivo.\n\nComo posso te chamar para iniciar seu atendimento?`;
        } else {
          parsed.reply_text = `Olá! Prazer receber você por aqui!\n\nComo posso te chamar para iniciar seu atendimento?`;
        }
      }
    }

    // Atualizar session state após a resposta
    const faqMatch = matchFAQ(lastUserMsg);
    updateSessionAfterResponse(sessionId, parsed, faqMatch);

    // Montar texto legado (com tags [CHIPS] e [MEDIA]) para retrocompatibilidade
    const legacyText = buildLegacyText(parsed);

    // Salvar no Firestore
    const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
    await messagesRef.add({
      text: legacyText,
      sender: "assistant",
      timestamp: FieldValue.serverTimestamp(),
    });

    console.log("Successfully wrote assistant response to Firestore.");
  } catch (error) {
    console.error("Error generating AI response:", error);
    try {
      const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
      await messagesRef.add({
        text: "Desculpe, ocorreu um erro de conexão com nosso servidor de inteligência artificial. Por favor, tente novamente.",
        sender: "assistant",
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch (dbErr) {
      console.error("Failed to write error fallback to DB:", dbErr);
    }
  }
}

// ============================================================================
// PROCESSAMENTO DE CHAT (Polling do Firestore)
// ============================================================================

/**
 * Avalia uma sessão de chat e decide se precisa gerar resposta IA
 */
async function processChat(sessionId: string) {
  try {
    const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
    const snapshot = await messagesRef.orderBy("timestamp", "asc").get();
    const messages: any[] = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1] as any;

    if (lastMessage.sender === "user") {
      const lastMsgId = lastMessage.id;

      if (processedMessageIds.has(lastMsgId)) return;
      processedMessageIds.add(lastMsgId);

      // Ignorar mensagens antigas (> 5 min)
      const msgTime = lastMessage.timestamp ? lastMessage.timestamp.toDate().getTime() : Date.now();
      if (Date.now() - msgTime > 300000) {
        console.log(`Skipping old message ${lastMsgId} in session ${sessionId}`);
        return;
      }

      // Emergência Médica (SAMU 192)
      if (isEmergency(lastMessage.text)) {
        const emergencyText =
          "IDENTIFICAMOS UMA POSSÍVEL EMERGÊNCIA MÉDICA. Por favor, ligue imediatamente para o SAMU (192) ou procure a UPA/Pronto-Socorro mais próximo. Nossa equipe não realiza atendimentos de urgência ou emergência.\n\n[CHIPS: Ligar SAMU 192 | Buscar Pronto-Socorro]";
        await messagesRef.add({
          text: emergencyText,
          sender: "assistant",
          timestamp: FieldValue.serverTimestamp(),
        });
        return;
      }

      // Limitador de Sessão
      const userMessages = messages.filter((m) => m.sender === "user");
      const currentCount = sessionMessageCount.get(sessionId) || 0;
      const totalUserMessages = Math.max(currentCount, userMessages.length);
      sessionMessageCount.set(sessionId, totalUserMessages);

      if (totalUserMessages >= MAX_SESSION_MESSAGES) {
        const msgRef = db.collection("chats").doc(sessionId).collection("messages");
        await msgRef.add({
          text: HANDOFF_MESSAGE,
          sender: "assistant",
          timestamp: FieldValue.serverTimestamp(),
        });
        console.log(`Session ${sessionId} reached message limit. Handoff sent.`);
        return;
      }

      // Limite de caracteres
      if (lastMessage.text && lastMessage.text.length > MAX_MESSAGE_LENGTH) {
        console.log(`[OTIMIZAÇÃO] Mensagem via polling excedeu limite de chars na sessão ${sessionId}`);
        await messagesRef.add({
          text: MESSAGE_TOO_LONG_RESPONSE,
          sender: "assistant",
          timestamp: FieldValue.serverTimestamp(),
        });
        return;
      }

      // Interceptor de FAQ Determinístico (apenas operacionais com score >= 85)
      const faqPollingMatch = matchFAQ(lastMessage.text);
      if (
        faqPollingMatch.matched &&
        faqPollingMatch.item &&
        !faqPollingMatch.isFunnelProtected &&
        faqPollingMatch.score >= 85 &&
        faqPollingMatch.item.origin === "operacional"
      ) {
        console.log(`[FAQ Interceptor Polling] Resposta direta servida (${faqPollingMatch.item.id}, Score: ${faqPollingMatch.score}%)`);
        let responseText = faqPollingMatch.item.resposta || "";
        if (faqPollingMatch.item.chips && faqPollingMatch.item.chips.length > 0) {
          responseText += `\n\n[CHIPS: ${faqPollingMatch.item.chips.join(" | ")}]`;
        }
        await messagesRef.add({
          text: responseText,
          sender: "assistant",
          timestamp: FieldValue.serverTimestamp(),
        });
        return;
      }

      await generateAiResponse(sessionId, messages);
    }
  } catch (error) {
    console.error(`Error processing chat ${sessionId}:`, error);
  }
}

// ============================================================================
// ROTAS DA API
// ============================================================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", projectId, databaseId });
});

// Chat principal (API direta)
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, history = [], skipSaveUser = false, skipSaveAssistant = false } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: "Missing sessionId or message" });
  }

  // 1. Interceptor de Emergência Médica (SAMU 192) — Prioridade Máxima
  if (isEmergency(message)) {
    console.log(`[EMERGÊNCIA MÉDICA] Interceptada para a sessão ${sessionId}`);
    const emergencyText =
      "IDENTIFICAMOS UMA POSSÍVEL EMERGÊNCIA MÉDICA. Por favor, ligue imediatamente para o SAMU (192) ou procure a UPA/Pronto-Socorro mais próximo. Nossa equipe não realiza atendimentos de urgência ou emergência.\n\n[CHIPS: Ligar SAMU 192 | Buscar Pronto-Socorro]";
    try {
      const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
      if (!skipSaveUser) {
        await messagesRef.add({ text: message, sender: "user", timestamp: FieldValue.serverTimestamp() });
      }
      if (!skipSaveAssistant) {
        await messagesRef.add({ text: emergencyText, sender: "assistant", timestamp: FieldValue.serverTimestamp() });
      }
    } catch (fsErr) {
      console.warn("Background Firestore backfill failed for emergency match:", fsErr);
    }
    return res.json({ text: emergencyText });
  }

  // 2. Verificar limite de mensagens da sessão
  const currentCount = sessionMessageCount.get(sessionId) || 0;
  if (currentCount >= MAX_SESSION_MESSAGES) {
    try {
      const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
      if (!skipSaveUser) {
        await messagesRef.add({ text: message, sender: "user", timestamp: FieldValue.serverTimestamp() });
      }
      await messagesRef.add({ text: HANDOFF_MESSAGE, sender: "assistant", timestamp: FieldValue.serverTimestamp() });
    } catch (err) {
      console.warn("Firestore save failed during handoff:", err);
    }
    return res.json({ text: HANDOFF_MESSAGE });
  }

  // Incrementar contador
  sessionMessageCount.set(sessionId, currentCount + 1);

  // 3. Limite de caracteres por mensagem
  if (message.length > MAX_MESSAGE_LENGTH) {
    console.log(`[OTIMIZAÇÃO] Mensagem excedeu ${MAX_MESSAGE_LENGTH} chars (${message.length} chars) na sessão ${sessionId}`);
    try {
      const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
      if (!skipSaveUser) {
        await messagesRef.add({ text: message, sender: "user", timestamp: FieldValue.serverTimestamp() });
      }
      await messagesRef.add({ text: MESSAGE_TOO_LONG_RESPONSE, sender: "assistant", timestamp: FieldValue.serverTimestamp() });
    } catch (err) {
      console.warn("Firestore save failed during message length check:", err);
    }
    sessionMessageCount.set(sessionId, currentCount); // Reverter
    return res.json({ text: MESSAGE_TOO_LONG_RESPONSE });
  }

  // 4. Interceptor de FAQ Determinístico (apenas operacionais com score >= 85)
  const faqMatch = matchFAQ(message);
  if (
    faqMatch.matched &&
    faqMatch.item &&
    !faqMatch.isFunnelProtected &&
    faqMatch.score >= 85 &&
    faqMatch.item.origin === "operacional"
  ) {
    console.log(`[FAQ Interceptor API] Resposta direta servida (${faqMatch.item.id}, Score: ${faqMatch.score}%) - 0ms, $0`);
    let responseText = faqMatch.item.resposta || "";
    if (faqMatch.item.chips && faqMatch.item.chips.length > 0) {
      responseText += `\n\n[CHIPS: ${faqMatch.item.chips.join(" | ")}]`;
    }

    try {
      const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
      if (!skipSaveUser) {
        await messagesRef.add({ text: message, sender: "user", timestamp: FieldValue.serverTimestamp() });
      }
      if (!skipSaveAssistant) {
        await messagesRef.add({ text: responseText, sender: "assistant", timestamp: FieldValue.serverTimestamp() });
      }
    } catch (fsErr) {
      console.warn("Background Firestore backfill failed for FAQ match:", fsErr);
    }

    return res.json({ text: responseText });
  }

  // 5. Chamada ao Gemini com todas as otimizações (Micro-RAG + Session Scratchpad + Structured Output)
  try {
    console.log(`Direct API Chat requested for session: ${sessionId}`);

    const allMessages = [...history, { sender: "user", text: message }];
    const prunedAllMessages = allMessages.slice(-MAX_HISTORY_MESSAGES);
    const contents = formatMessagesForGemini(prunedAllMessages);

    // Tentar extrair nome e variáveis da sessão (origem/temperatura, alvo, idade)
    tryExtractSessionVariables(sessionId, message);

    // Montar instrução enriquecida: System Prompt + Session Memory + RAG
    const stateInjection = buildStateInjection(sessionId);
    const ragContext = retrieveRelevantContext(message);
    const enrichedInstruction = systemInstruction + stateInjection + ragContext;

    // Chamar Gemini com Structured Output
    const aiText = await callGeminiWithFallback({
      contents,
      systemInstruction: enrichedInstruction,
      useStructuredOutput: true,
    });

    // Parsear JSON estruturado
    const parsed = parseLyaResponse(aiText);

    // Atualizar session state
    updateSessionAfterResponse(sessionId, parsed, faqMatch);

    // Montar texto legado para retrocompatibilidade
    const legacyText = buildLegacyText(parsed);

    // Salvar no Firestore
    try {
      const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
      if (!skipSaveUser) {
        await messagesRef.add({ text: message, sender: "user", timestamp: FieldValue.serverTimestamp() });
      }
      if (!skipSaveAssistant) {
        await messagesRef.add({ text: legacyText, sender: "assistant", timestamp: FieldValue.serverTimestamp() });
        console.log("Successfully backfilled assistant response to Firestore via Admin SDK.");
      }
    } catch (fsErr) {
      console.warn("Background Firestore backfill failed (continuing to respond):", fsErr);
    }

    res.json({ text: legacyText });
  } catch (error: any) {
    console.error("Error in direct API /api/chat:", error);

    // Handle 429 Quota Exceeded
    if (error?.status === 429 || error?.message?.includes("429") || error?.message?.includes("Quota exceeded")) {
      const fallbackText = "Nosso sistema está com alto volume de acessos no momento. Por favor, aguarde um instante e tente novamente.";
      try {
        const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
        if (!skipSaveAssistant) {
          await messagesRef.add({ text: fallbackText, sender: "assistant", timestamp: FieldValue.serverTimestamp() });
        }
      } catch (fsErr) {
        console.warn("Failed to backfill 429 fallback to Firestore:", fsErr);
      }
      return res.json({ text: fallbackText });
    }

    res.status(500).json({ error: error instanceof Error ? error.message : "Internal Server Error" });
  }
});

// Transcrição de áudio
app.post("/api/transcribe", async (req, res) => {
  const { audio } = req.body;
  if (!audio) {
    return res.status(400).json({ error: "Missing audio parameter" });
  }

  try {
    const match = audio.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Invalid audio format" });
    }

    const mimeType = match[1];
    const base64Data = match[2];

    console.log(`Transcribing audio of mimeType: ${mimeType}`);

    const transcribedText = await transcribeAudio(mimeType, base64Data);

    // Limite de caracteres: truncar transcrição de áudio muito longo
    if (transcribedText.length > MAX_MESSAGE_LENGTH) {
      console.log(`[OTIMIZAÇÃO] Transcrição excedeu ${MAX_MESSAGE_LENGTH} chars (${transcribedText.length} chars). Truncando.`);
      const truncated = transcribedText.substring(0, MAX_MESSAGE_LENGTH);
      return res.json({ text: truncated, truncated: true, originalLength: transcribedText.length });
    }

    console.log(`Transcription result: "${transcribedText}"`);
    res.json({ text: transcribedText });
  } catch (error) {
    console.error("Error in /api/transcribe:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal Server Error" });
  }
});

// Resumo para secretária
app.post("/api/summary", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId parameter" });
  }

  try {
    const messagesRef = db.collection("chats").doc(sessionId).collection("messages");
    const snapshot = await messagesRef.orderBy("timestamp", "asc").get();

    if (snapshot.empty) {
      return res.status(404).json({ error: "No messages found for this session" });
    }

    const conversationText = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const role = data.sender === "user" ? "Paciente" : "Assistente";
        return `${role}: ${data.text}`;
      })
      .join("\n");

    const summary = await generateSummary(conversationText);

    // Salvar resumo no documento da sessão
    await db.collection("chats").doc(sessionId).set(
      { summary, summaryGeneratedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    console.log(`Summary generated for session ${sessionId}: ${summary}`);
    res.json({ summary });
  } catch (error) {
    console.error("Error in /api/summary:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal Server Error" });
  }
});

// ============================================================================
// STARTUP (Vite dev ou produção estática)
// ============================================================================
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
