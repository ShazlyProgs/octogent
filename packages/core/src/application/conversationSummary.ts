/**
 * Conversation-summary adapter — pure domain for the #45 W-ORCH-NATIVE Phase 3 [D9] chat
 * "summarize a conversation" parity (the retiring :3001 dashboard Chat's `POST /:id/summarize`).
 *
 * Decision doc §8 [D9] + fleet/CHAT-PARITY.md: "octogent-native session summary over
 * ConversationSessionSummary (turn/user/assistant counts + previews already exist in the domain)."
 * The legacy engine asked an LLM to summarize the discussion; octogent DROPS the LLM and builds a
 * DETERMINISTIC summary from the transcript's already-computed counts + previews. This is honest
 * parity for the "give me a quick recap" affordance without any model call — the counts and the
 * first/last turn previews are exactly what ConversationSessionSummary already carries.
 *
 * This module performs NO I/O. The transcript read + the (optional) sidecar persistence live in
 * apps/api (`runtime.summarizeConversation`).
 */

/** The already-computed session facts a deterministic summary is built from. */
export type ConversationSummaryInput = {
  turnCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  firstUserTurnPreview: string | null;
  lastUserTurnPreview: string | null;
  lastAssistantTurnPreview: string | null;
};

const pluralizeTurns = (count: number): string => `${count} message${count === 1 ? "" : "s"}`;

/**
 * Build a concise, deterministic recap of a conversation from its counts + previews. Returns a
 * short empty-state line when there are no turns yet; otherwise a counts line followed by the
 * opening turn, the latest user turn (when it differs from the opener), and the latest reply.
 */
export const buildConversationSummaryText = (input: ConversationSummaryInput): string => {
  if (input.turnCount <= 0) {
    return "No messages in this conversation yet.";
  }

  const lines: string[] = [
    `${pluralizeTurns(input.turnCount)} — ${input.userTurnCount} from the user, ${input.assistantTurnCount} from the assistant.`,
  ];

  if (input.firstUserTurnPreview) {
    lines.push(`Opened with: "${input.firstUserTurnPreview}".`);
  }

  if (input.lastUserTurnPreview && input.lastUserTurnPreview !== input.firstUserTurnPreview) {
    lines.push(`Latest from the user: "${input.lastUserTurnPreview}".`);
  }

  if (input.lastAssistantTurnPreview) {
    lines.push(`Latest reply: "${input.lastAssistantTurnPreview}".`);
  }

  return lines.join("\n");
};
