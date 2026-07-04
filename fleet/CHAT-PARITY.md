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
| Rename / update metadata | `PUT /:id` | adapter | session-metadata rename over the transcript store (no LLM) |
| **Send a message (the chat turn)** | `POST /:id/messages` | adapter ✓ **PROVEN** | **KEYSTONE (built Phase 3 m2)** — submit input to the tentacle session + surface the transcript reply, with the per-conversation processing lock. Now: `POST /api/conversations/:id/messages` → `runtime.submitConversationMessage` over the pure `sendMessage.ts` contract |
| Generate a title | `POST /:id/generate-title` · `/:id/auto-title` | adapter | derive from `ConversationSessionSummary.firstUserTurnPreview` |
| Summarize | `POST /:id/summarize` | adapter | octogent-native session summary over `ConversationSessionSummary` |
| Attach a document | `POST /:id/upload` | adapter | write the upload into the tentacle's worktree workspace |
| Delegate to an agent | `POST /:id/delegate` | drop | delegation-engine path; octogent delegation = CEO→C-suite tentacle-tree channel messaging ([D1]/[D2]) |
| Suggested replies | `POST /:id/suggestions` | drop | engine-coupled reply nicety; retire with the engine |
| Search documents from chat | `GET /documents/search` | drop | KB/RAG — served by the back-office KB tool seam (`BACKOFFICE-TOOLS.md` follow-up), not the chat surface |

Current tally: **3 native · 6 adapter · 3 drop** — of the 6 adapters, **2 proven** (send-message m2, create-conversation m3), 4 pending.

## The retire gate (D9 "no hard cut", machine-checkable)

`summarizeChatParity().retireReady` is **true only when every non-drop capability is native or an adapter with `parityProven: true`.** Today it is **NO** — the send-message keystone is proven (Phase 3 m2) but 5 adapters remain unproven — so the legacy dashboard Chat **must not be cut**. As each remaining adapter lands + is verified, its registry row flips to `parityProven: true` (and `markChatParityProven(id, matrix)` composes the same flip in tests); when `pendingAdapters` empties, the gate opens and (only then) `routes/conversations.ts` may be retired (Phase 4 excision aligns).

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

## Cut-line (remaining Phase 3 work — deliberately not yet)

- **4 adapters still pending**: rename / title / summary / attach. Each lands next, flipping its registry row + adding its own tests.
- **No `:3001` change.** The dashboard Chat stays live and untouched; its retirement is Phase 4 (engine excision) and is **gated on `retireReady === true`**, not on a date.
- **Drops are not re-implemented.** `delegate` / `suggestions` / `documents-search` retire with the engine; they are excluded from the gate by design.
