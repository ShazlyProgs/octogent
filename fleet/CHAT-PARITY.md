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
| Start a conversation | `POST /` | adapter | create a chat session bound to a tentacle terminal ([D8]) |
| Rename / update metadata | `PUT /:id` | adapter | session-metadata rename over the transcript store (no LLM) |
| **Send a message (the chat turn)** | `POST /:id/messages` | adapter | **KEYSTONE** — submit input to the tentacle session + surface the transcript reply, with the per-conversation processing lock |
| Generate a title | `POST /:id/generate-title` · `/:id/auto-title` | adapter | derive from `ConversationSessionSummary.firstUserTurnPreview` |
| Summarize | `POST /:id/summarize` | adapter | octogent-native session summary over `ConversationSessionSummary` |
| Attach a document | `POST /:id/upload` | adapter | write the upload into the tentacle's worktree workspace |
| Delegate to an agent | `POST /:id/delegate` | drop | delegation-engine path; octogent delegation = CEO→C-suite tentacle-tree channel messaging ([D1]/[D2]) |
| Suggested replies | `POST /:id/suggestions` | drop | engine-coupled reply nicety; retire with the engine |
| Search documents from chat | `GET /documents/search` | drop | KB/RAG — served by the back-office KB tool seam (`BACKOFFICE-TOOLS.md` follow-up), not the chat surface |

Current tally: **3 native · 6 adapter · 3 drop.**

## The retire gate (D9 "no hard cut", machine-checkable)

`summarizeChatParity().retireReady` is **true only when every non-drop capability is native or an adapter with `parityProven: true`.** Today it is **NO** — all 6 adapters are unproven — so the legacy dashboard Chat **must not be cut**. As each adapter lands + is verified in a later milestone, `markChatParityProven(id, matrix)` flips it; when `pendingAdapters` empties, the gate opens and (only then) `routes/conversations.ts` may be retired (Phase 4 excision aligns).

```bash
# from $OCTOGENT (octogent repo root)
node bin/octogent chat-parity            # print the full matrix + native/adapter/drop tally + retire gate
node bin/octogent chat-parity --summary  # { total, native, adapter, drop, pendingAdapters[], retireReady } as JSON
```

## Cut-line (milestone 1 — deliberately not yet)

- **No chat built here.** This grounds the parity contract + gate. The interactive wiring (create-session / send-message / title / summary / rename / attach) lands as the adapter milestones in `apps/api`, each flipping its row via `markChatParityProven` and adding its own tests — `send-message` (the chat turn over the terminal-session runtime) is the keystone and sequenced first.
- **No `:3001` change.** The dashboard Chat stays live and untouched; its retirement is Phase 4 (engine excision) and is **gated on `retireReady === true`**, not on a date.
- **Drops are not re-implemented.** `delegate` / `suggestions` / `documents-search` retire with the engine; they are excluded from the gate by design.
