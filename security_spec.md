# Security Specification for Instagram Direct Chat

This document details the security model, data invariants, and the "Dirty Dozen" vulnerability test vectors to ensure absolute safety on our Firestore instance.

## 1. Data Invariants
- A chat document at `/chats/{session_id}` must only be read, created, or updated if the authenticated user's `uid` matches `{session_id}`.
- A message document at `/chats/{session_id}/messages/{messageId}` must only be read, created, or updated if the authenticated user's `uid` matches `{session_id}`.
- Messages must have `sender` equal to either `user` or `assistant`.
- Messages created by the user must have `sender` equal to `user` and `text` must be valid string with size limits.

## 2. The "Dirty Dozen" Payloads (Malicious Attacks)

Below are 12 JSON payloads designed to test and break our Firestore rules, showing that they MUST return `PERMISSION_DENIED`.

### Attack 1: User tries to write to another user's session
- **Collection**: `/chats/attacker_uid/messages/msg123` -> Writing to `/chats/victim_uid/messages/msg123`
- **Payload**: `{ "text": "Hi", "sender": "user", "timestamp": "request.time" }`
- **Expected Result**: `PERMISSION_DENIED` (auth.uid !== session_id)

### Attack 2: User tries to write a message claiming to be the assistant
- **Collection**: `/chats/user_uid/messages/msg123`
- **Payload**: `{ "text": "I am the AI", "sender": "assistant", "timestamp": "request.time" }`
- **Expected Result**: `PERMISSION_DENIED` (user cannot spoof assistant role on write)

### Attack 3: User tries to write a message with missing fields
- **Collection**: `/chats/user_uid/messages/msg123`
- **Payload**: `{ "text": "Incomplete" }`
- **Expected Result**: `PERMISSION_DENIED` (fails key size or presence checks)

### Attack 4: User tries to inject a massive text block (Denial of Wallet)
- **Collection**: `/chats/user_uid/messages/msg123`
- **Payload**: `{ "text": "[10MB string]", "sender": "user", "timestamp": "request.time" }`
- **Expected Result**: `PERMISSION_DENIED` (fails size check `< 10000`)

### Attack 5: User tries to forge the timestamp using a client timestamp
- **Collection**: `/chats/user_uid/messages/msg123`
- **Payload**: `{ "text": "Hello", "sender": "user", "timestamp": "2020-01-01T00:00:00Z" }`
- **Expected Result**: `PERMISSION_DENIED` (timestamp must be server time `request.time`)

### Attack 6: Unauthenticated user tries to read any chat
- **Collection**: `/chats/some_session`
- **Payload**: `GET /chats/some_session` (No Auth)
- **Expected Result**: `PERMISSION_DENIED` (not signed in)

### Attack 7: User tries to inject extra fields (Ghost Fields/Shadow Update)
- **Collection**: `/chats/user_uid/messages/msg123`
- **Payload**: `{ "text": "Hello", "sender": "user", "timestamp": "request.time", "isAdmin": true, "ghost": "leak" }`
- **Expected Result**: `PERMISSION_DENIED` (fails strict key count constraint `keys().size() == 3`)

### Attack 8: User tries to modify an existing message (Immutability Violation)
- **Collection**: `/chats/user_uid/messages/msg123`
- **Payload**: `{ "text": "Edited text", "sender": "user", "timestamp": "request.time" }`
- **Expected Result**: `PERMISSION_DENIED` (messages once written are immutable)

### Attack 9: User tries to delete a message
- **Collection**: `/chats/user_uid/messages/msg123`
- **Payload**: `DELETE` message
- **Expected Result**: `PERMISSION_DENIED` (deleting messages is forbidden)

### Attack 10: User tries to query all chats (Scraping/Blanket Read)
- **Collection**: `/chats`
- **Payload**: `LIST /chats`
- **Expected Result**: `PERMISSION_DENIED` (only get/list with strict session filter is allowed)

### Attack 11: Injecting malformed session_id as project/resource poisoning
- **Collection**: `/chats/malicious-session-with-huge-id-123456789...`
- **Payload**: `{ "createdAt": "request.time" }`
- **Expected Result**: `PERMISSION_DENIED` (session_id exceeds character limit or contains invalid characters)

### Attack 12: User tries to overwrite a system-generated message
- **Collection**: `/chats/user_uid/messages/system_msg`
- **Payload**: `{ "text": "Overwritten AI", "sender": "assistant", "timestamp": "request.time" }`
- **Expected Result**: `PERMISSION_DENIED`

## 3. Test Runner
We enforce these specs directly through our `firestore.rules` and verify them in the application integration code.
