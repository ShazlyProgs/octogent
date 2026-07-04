# Chat parity — supersede the dashboard Chat (#45 W-ORCH-NATIVE, Phase 3)

> Authority: `$VAULT/40-Plans/Active/2026-06-30-W-ORCH-NATIVE-architecture-decision-doc.md` §8 (ruling **D9**) + `2026-06-30-W-ORCH-NATIVE-build-plan.md` **Phase 3**. Built 2026-07-04 on branch `feat/45-phase1` (MASTER-LIST r92, Phase 3 milestone 1).

## Why

Decision doc §8 **[D9]**: the daily-used dashboard Chat — the retiring `:3001` engine's `server/routes/conversations.ts` (13 endpoints, ~2136 LOC) — is **SUPERSEDED** by an octogent-native chat surface. The ruling is explicit about sequencing: **build octogent chat parity first, THEN retire the dashboard Chat — no hard cut.** Phase 3 milestone 1 does not build the chat yet; it **grounds what parity means** and makes the retire gate machine-checkable, exactly as Phase 2 m1 grounded the back-office "tools" seam before wiring it.

## What's here

| Path | What |
|---|---|
| `../packages/core/src/application/chatParity.ts` | Pure, dependency-free core: the **parity matrix** (one row per legacy Chat capability → its octogent disposition + mapping), plus `getChatParityCapabilities()`, `findChatParityCapability(id)`, `markChatParityProven(id, matrix?)` (compose as adapters land), and `summarizeChatParity(matrix?)` → the **retire gate**. No I/O. Tests: `packages/core/tests/chatParity.test.ts` (7). |
| `../apps/api/src/cli.ts` | `octogent chat-parity` — prints the matrix (or `--summary` JSON) so an operator/agent can see the remaining Phase 3 work + the retire-ready gate. |

## The parity matrix (grounded 1:1 against `routes/conversations.ts`)

Three dispositions. **native** = octogent already serves it (its existing read/list/delete transcript routes in `apps/api/src/createApiServer/conversationRoutes.ts`). **adapter** = parity needs a thin octogent-native adapter over EXISTING primitives (terminal-session input-submit, the JSONL transcript, channel messaging, `ConversationSessionSummary`) — the Phase 3 build work. **drop** = engine-coupled or superseded by the fleet topology; retire WITH the engine, do not reimplement.

| Legacy Chat capability | Route | Disposition | octogent parity |
|---|---|---|---|
| List conversations | `GET /` | native | `GET /api/conversations` |
| Get conversation + messages | `GET /:id` | native | `GET /api/conversations/:id` |
| Delete conversation | `DELETE /:id` | native | `DELETE /api/conversations/:id` (+ clear-all) |
| Start a conversation | `POST /` | adapter ✓ **PROVEN** | **built Phase 3 m3** — create a chat session bound to a tentacle terminal ([D8]) via `createTerminal`; `POST /api/conversations` → `runtime.createConversation` over the pure `createConversation.ts` contract |
| Rename / update metadata | `PUT /:id` | adapter ✓ **PROVEN** | **built Phase 3 m4** — session-metadata rename over the transcript store (no LLM); title persisted in a `.meta.json` sidecar + surfaced on the summary; `PUT /api/conversations/:id` → `runtime.renameConversation` |
| **Send a message (the chat turn)** | `POST /:id/messages` | adapter ✓ **PROVEN** | **KEYSTONE (built Phase 3 m2)** — submit input to the tentacle session + surface the transcript reply, with the per-conversation processing lock. Now: `POST /api/conversations/:id/messages` → `runtime.submitConversationMessage` over the pure `sendMessage.ts` contract |
| Generate a title | `POST /:id/generate-title` · `/:id/auto-title` | adapter ✓ **PROVEN** | **built Phase 3 m5** — derive from `firstUserTurnPreview` (no LLM); read auto-derives (auto-title fold), `POST /api/conversations/:id/title` PINS it via `runtime.generateConversationTitle` |
| Summarize | `POST /:id/summarize` | adapter ✓ **PROVEN** | **built Phase 3 m6** — deterministic recap over the transcript's counts + previews (no LLM); `POST /api/conversations/:id/summarize` → `runtime.summarizeConversation` |
| Attach a document | `POST /:id/upload` | adapter … **GROUNDWORK, NOT PROVEN** | **built Phase 3 m7 but row NOT flipped** — `runtime.attachDocumentToConversation` writes the upload into the tentacle workspace (`.octogent/attachments/<sessionId>/`) + records a transcript note; validated by the pure `attachDocument.ts` (sanitize + size cap). Stays UNPROVEN: octogent has no per-conversation document store (shared conversation's workspace = repo root) and nothing feeds the doc into the live agent's context |
| Delegate to an agent | `POST /:id/delegate` | drop | delegation-engine path; octogent delegation = CEO→C-suite tentacle-tree channel messaging ([D1]/[D2]) |
| Suggested replies | `POST /:id/suggestions` | drop | engine-coupled reply nicety; retire with the engine |
| Search documents from chat | `GET /documents/search` | drop | KB/RAG — served by the back-office KB tool seam (`BACKOFFICE-TOOLS.md` follow-up), not the chat surface |

Current tally: **3 native · 6 adapter · 3 drop** — of the 6 adapters, **5 proven** (send-message m2, create-conversation m3, rename-conversation m4, conversation-title m5, conversation-summary m6). The 6th, **attach-document (m7), is built as real groundwork but deliberately NOT flipped** (no per-conversation document store — see below), so the retire gate stays **NO**.

## The retire gate (D9 "no hard cut", machine-checkable)

`summarizeChatParity().retireReady` is **true only when every non-drop capability is native or an adapter with `parityProven: true`.** Today it is **NO** — 5 of the 6 adapters are proven (send-message m2, create-conversation m3, rename-conversation m4, conversation-title m5, conversation-summary m6) but **attach-document is deliberately left unproven** (its groundwork is built, but octogent lacks a per-conversation document store + an agent-ingestion path — a false flip would be the worst outcome). So `pendingAdapters === ["attach-document"]` and the legacy dashboard Chat **must not be cut**. When (and only when) a real document store lands and `pendingAdapters` empties, the gate opens and `routes/conversations.ts` may be retired (Phase 4 excision aligns). `markChatParityProven(id, matrix)` composes the same flip in tests.

```bash
# from $OCTOGENT (octogent repo root)
node bin/octogent chat-parity            # print the full matrix + native/adapter/drop tally + retire gate
node bin/octogent chat-parity --summary  # { total, native, adapter, drop, pendingAdapters[], retireReady } as JSON
```

## Milestone 2 — the send-message keystone (built)

The chat turn is now octogent-native and proven:
- **Pure contract**: `packages/core/src/application/sendMessage.ts` — `buildConversationInputSubmit` (content validation → legacy 400; bracketed-paste + CR PTY payload matching `channelMessaging.ts`) + `resolveSendMessageDisposition` (the B.14 per-conversation processing lock: idle → ready, processing → busy/409, no live session → 404). No I/O. Tests: `packages/core/tests/sendMessage.test.ts`.
- **Wiring**: `runtime.submitConversationMessage(sessionId, content)` (terminalRuntime.ts) resolves the lock from the live session's `agentState`, records the user turn as an `input_submit` transcript event (`sessionRuntime.recordInputSubmit`), then submits the payload via the proven `writeInput` PTY primitive (which flips the session to `processing`, arming the lock). Route: `POST /api/conversations/:id/messages` → 202 accepted / 409 busy / 404 no-session / 400 invalid-content. Tests: `apps/api/tests/conversationSendMessage.test.ts` (drives a real session over a mocked PTY).
- **The reply is not synchronous**: unlike the legacy engine (`runClaude` → reply inline), the tentacle IS Claude Code ([D8]); the assistant reply streams into the transcript and is surfaced by the **already-native** `GET /api/conversations/:id`. So the route returns 202 (accepted), not the reply body — this is the architectural shape, not a parity gap.

## Milestones 3-6 — the four adapters that landed proven (built)

- **m3 create-conversation** (`POST /`): `packages/core/src/application/createConversation.ts` (`buildCreateConversationRequest` — required `initialPrompt`, the honest analog of legacy's required agent binding; workspaceMode enum; optional title) → `runtime.createConversation` over the existing `createTerminal` primitive (spawns a live Claude Code session). Route `POST /api/conversations` → 201 / 400. Tests prove the created conversation is FUNCTIONAL (accepts a send-message turn).
- **m4 rename-conversation** (`PUT /:id`): `renameConversation.ts` (`buildConversationRename` — required title, trimmed, capped) → `runtime.renameConversation` persists the title in a `.meta.json` sidecar over the transcript store (no LLM); surfaced on the summary. Route `PUT /api/conversations/:id` → 200 / 400 / 404.
- **m5 conversation-title** (`generate-title` + `auto-title`, folded): `conversationTitle.ts` (`deriveConversationTitle` = the deterministic auto-title; `resolveConversationTitle` = stored-wins-else-derived). The read path auto-derives (auto-title fold); `POST /api/conversations/:id/title` PINS it via `runtime.generateConversationTitle`. No LLM.
- **m6 conversation-summary** (`POST /:id/summarize`): `conversationSummary.ts` (`buildConversationSummaryText` — a deterministic recap over the transcript's counts + previews) → `runtime.summarizeConversation` (persists to the sidecar). Route `POST /api/conversations/:id/summarize` → 200 / 404. No LLM.

## Milestone 7 — attach-document (groundwork built, NOT flipped)

The pure contract + the runtime write are real and tested, but the disposition row is **deliberately left `parityProven: false`**:
- **Built**: `packages/core/src/application/attachDocument.ts` (`sanitizeAttachmentFilename` path-traversal-safe basename + `buildDocumentAttachment` size cap) + `runtime.attachDocumentToConversation` — writes the upload into the tentacle's workspace under `.octogent/attachments/<sessionId>/`, records a transcript note when a live session exists. Route `POST /api/conversations/:id/documents` (JSON `{ filename, content }`) → 201 / 400 / 404. Tests: `packages/core/tests/attachDocument.test.ts` + `apps/api/tests/conversationAttachDocument.test.ts`.
- **Why unproven** (honest D9 gate): octogent has **no per-conversation document store**. For the DEFAULT shared conversation the tentacle "workspace" is the whole repo root, so attachments land in an ad-hoc subdir rather than a managed store; and **nothing delivers the document into the live agent's context** the way the legacy `POST /:id/upload` appended the converted content as a consumable message. The legacy upload's PURPOSE — the agent using the uploaded content in the turn — is not met. Flipping this would be a false flip.
- **To flip later**: add a real per-conversation (or per-tenant) document store + an ingestion path that feeds the attachment into the session, then set `parityProven: true` — at which point `retireReady` opens on its own.

## Cut-line

- **1 adapter still pending**: attach-document (see above). The retire gate stays **NO** until it is honestly proven.
- **No `:3001` change.** The dashboard Chat stays live and untouched; its retirement is Phase 4 (engine excision) and is **gated on `retireReady === true`**, not on a date.
- **Drops are not re-implemented.** `delegate` / `suggestions` / `documents-search` retire with the engine; they are excluded from the gate by design.
