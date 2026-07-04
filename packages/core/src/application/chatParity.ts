/**
 * Chat-parity registry — pure domain for the #45 W-ORCH-NATIVE Phase 3 "chat supersede" seam.
 *
 * Decision doc §8 [D9]: the daily-used dashboard Chat (the retiring :3001 engine's
 * `server/routes/conversations.ts`) is SUPERSEDED by an octogent-native chat surface —
 * "build octogent chat parity first, THEN retire the dashboard Chat (no hard cut)".
 * This module is the framework-agnostic PARITY CONTRACT that gates that cut: it enumerates
 * every capability of the legacy dashboard Chat, maps each to its octogent-native parity,
 * and computes whether parity is proven enough to retire the legacy surface. It performs no
 * I/O and builds no chat — the interactive wiring (session input-submit + transcript reply)
 * lands in apps/api over later Phase 3 milestones; this milestone grounds WHAT parity means.
 *
 * Three parity dispositions (grounded against the legacy routes + octogent's existing
 * conversation surface in apps/api/src/createApiServer/conversationRoutes.ts):
 *  - "native"  — octogent already serves this today (the read/list/delete transcript routes);
 *                parity is inherently proven.
 *  - "adapter" — parity needs a thin octogent-native adapter over EXISTING primitives
 *                (terminal session input-submit, the JSONL transcript, channel messaging,
 *                ConversationSessionSummary). This is the Phase 3 build work; `parityProven`
 *                starts false and flips true once the adapter lands + is verified.
 *  - "drop"    — engine-coupled or superseded by the fleet topology; retire WITH the engine,
 *                do NOT reimplement. Excluded from the parity gate.
 *
 * The retire gate (`summarizeChatParity().retireReady`) is false until every non-drop
 * capability is native or an adapter with `parityProven: true` — the machine-checkable form
 * of D9's "no hard cut". See fleet/CHAT-PARITY.md.
 */

export type ChatParityDisposition = "native" | "adapter" | "drop";

export type ChatParityCapability = {
  /** Stable id (kebab-case) for the capability. */
  id: string;
  /** Human title. */
  title: string;
  /** The legacy dashboard Chat route this capability corresponds to
   *  (method + path in CollegaAgents_CollegaOrchestration/server/routes/conversations.ts). */
  legacyRoute: string;
  disposition: ChatParityDisposition;
  /** For native: the octogent route/primitive that already serves it.
   *  For adapter: the octogent primitive the adapter is built over + what it must add.
   *  For drop: the retire rationale. */
  octogentParity: string;
  /** Whether parity is proven for this capability today.
   *  native → true; drop → not applicable (recorded false, excluded from the gate);
   *  adapter → false until the adapter lands + is verified. */
  parityProven: boolean;
};

export type ChatParitySummary = {
  total: number;
  native: number;
  adapter: number;
  drop: number;
  /** adapter capabilities not yet proven — the remaining Phase 3 build list. */
  pendingAdapters: string[];
  /** D9 gate: true only when every non-drop capability is native or a proven adapter. */
  retireReady: boolean;
};

export class ChatParityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatParityError";
  }
}

// ---------------------------------------------------------------------------
// The parity matrix. One row per legacy dashboard Chat capability, grounded 1:1
// against server/routes/conversations.ts. octogent's existing native surface is
// list/search/get/delete/export of tentacle-session transcripts
// (createApiServer/conversationRoutes.ts) — the interactive/write capabilities are
// the adapter work; the delegation + KB + reply-nicety capabilities are dropped.
// ---------------------------------------------------------------------------

const CHAT_PARITY: ChatParityCapability[] = [
  // ---- Already native (octogent transcript surface) ----------------------
  {
    id: "list-conversations",
    title: "List conversations",
    legacyRoute: "GET /",
    disposition: "native",
    octogentParity: "GET /api/conversations (runtime.listConversationSessions — session summaries)",
    parityProven: true,
  },
  {
    id: "get-conversation",
    title: "Get one conversation + its messages",
    legacyRoute: "GET /:id",
    disposition: "native",
    octogentParity: "GET /api/conversations/:id (session detail: turns + events)",
    parityProven: true,
  },
  {
    id: "delete-conversation",
    title: "Delete a conversation",
    legacyRoute: "DELETE /:id",
    disposition: "native",
    octogentParity: "DELETE /api/conversations/:id (+ DELETE /api/conversations clears all)",
    parityProven: true,
  },
  // ---- Adapter work — thin octogent-native wiring over existing primitives ----
  {
    id: "create-conversation",
    title: "Start a new conversation",
    legacyRoute: "POST /",
    disposition: "adapter",
    octogentParity:
      "Start a chat session bound to a tentacle terminal (native Claude Code session, [D8]); needs a create-chat-session entry over the terminal runtime.",
    parityProven: false,
  },
  {
    id: "rename-conversation",
    title: "Rename / update conversation metadata",
    legacyRoute: "PUT /:id",
    disposition: "adapter",
    octogentParity:
      "Session-metadata rename over the transcript store (no LLM); adapter in apps/api.",
    parityProven: false,
  },
  {
    id: "send-message",
    title: "Send a message and get the agent reply (the chat turn)",
    legacyRoute: "POST /:id/messages",
    disposition: "adapter",
    octogentParity:
      "KEYSTONE: submit input to the tentacle session (terminal runtime input-submit) + surface the transcript reply, with the legacy per-conversation processing lock. Tentacles ARE Claude Code sessions ([D8]) so no claude-client.ts in the loop.",
    parityProven: false,
  },
  {
    id: "conversation-title",
    title: "Generate a conversation title",
    legacyRoute: "POST /:id/generate-title (+ POST /:id/auto-title)",
    disposition: "adapter",
    octogentParity:
      "octogent-native title derived from ConversationSessionSummary.firstUserTurnPreview (auto-title folds in here); the legacy LLM title is a nicety, not a dependency.",
    parityProven: false,
  },
  {
    id: "conversation-summary",
    title: "Summarize a conversation",
    legacyRoute: "POST /:id/summarize",
    disposition: "adapter",
    octogentParity:
      "octogent-native session summary over ConversationSessionSummary (turn/user/assistant counts + previews already exist in the domain).",
    parityProven: false,
  },
  {
    id: "attach-document",
    title: "Attach a document to a conversation",
    legacyRoute: "POST /:id/upload",
    disposition: "adapter",
    octogentParity: "Write the upload into the tentacle's worktree workspace; adapter in apps/api.",
    parityProven: false,
  },
  // ---- Dropped — retire with the engine, do NOT reimplement ---------------
  {
    id: "delegate-to-agent",
    title: "Delegate the conversation to an agent",
    legacyRoute: "POST /:id/delegate",
    disposition: "drop",
    octogentParity:
      "Delegation-engine path (agent_id → buildConversationPrompt → runClaude). Superseded by the fleet topology: octogent delegation is CEO→C-suite tentacle-tree channel messaging ([D1]/[D2]). Retire with the engine.",
    parityProven: false,
  },
  {
    id: "reply-suggestions",
    title: "Suggested replies",
    legacyRoute: "POST /:id/suggestions",
    disposition: "drop",
    octogentParity:
      "Engine-coupled reply nicety (LLM-generated suggestion chips). Not core chat; retire with the engine rather than port.",
    parityProven: false,
  },
  {
    id: "document-search",
    title: "Search documents from chat",
    legacyRoute: "GET /documents/search",
    disposition: "drop",
    octogentParity:
      "KB/RAG search — served by the back-office KB tool seam (fleet/BACKOFFICE-TOOLS.md follow-up), not the chat surface. Dropped from chat parity.",
    parityProven: false,
  },
];

export const getChatParityCapabilities = (): ChatParityCapability[] => [...CHAT_PARITY];

export const findChatParityCapability = (id: string): ChatParityCapability | undefined =>
  CHAT_PARITY.find((cap) => cap.id === id);

/**
 * Mark an adapter capability as parity-proven. Returns a NEW capability list (the input —
 * the live registry by default — is never mutated), so calls compose as each Phase 3 adapter
 * lands: `matrix = markChatParityProven(id, matrix)`. Throws ChatParityError for an unknown id
 * or a non-adapter capability — native rows are already proven and drop rows are excluded from
 * the gate.
 */
export const markChatParityProven = (
  id: string,
  capabilities: ChatParityCapability[] = CHAT_PARITY,
): ChatParityCapability[] => {
  const cap = capabilities.find((c) => c.id === id);
  if (!cap) {
    const available = capabilities.map((c) => c.id).join(", ");
    throw new ChatParityError(`Unknown chat capability "${id}". Available: ${available}`);
  }
  if (cap.disposition !== "adapter") {
    throw new ChatParityError(
      `Capability "${id}" is "${cap.disposition}", not an adapter — only adapter parity is proven incrementally.`,
    );
  }
  return capabilities.map((c) => (c.id === id ? { ...c, parityProven: true } : { ...c }));
};

/**
 * Summarize a parity matrix (defaults to the live registry). `retireReady` is the D9 cut
 * gate: true only when every non-drop capability is native or a proven adapter.
 */
export const summarizeChatParity = (
  capabilities: ChatParityCapability[] = CHAT_PARITY,
): ChatParitySummary => {
  const native = capabilities.filter((c) => c.disposition === "native").length;
  const adapter = capabilities.filter((c) => c.disposition === "adapter").length;
  const drop = capabilities.filter((c) => c.disposition === "drop").length;
  const pendingAdapters = capabilities
    .filter((c) => c.disposition === "adapter" && !c.parityProven)
    .map((c) => c.id);
  const retireReady = capabilities.every(
    (c) => c.disposition === "drop" || c.disposition === "native" || c.parityProven,
  );
  return {
    total: capabilities.length,
    native,
    adapter,
    drop,
    pendingAdapters,
    retireReady,
  };
};
