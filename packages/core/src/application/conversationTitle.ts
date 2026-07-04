/**
 * Conversation-title adapter — pure domain for the #45 W-ORCH-NATIVE Phase 3 [D9] chat "generate a
 * title" parity (the retiring :3001 dashboard Chat's `POST /:id/generate-title` + `POST
 * /:id/auto-title`, and the inline auto-title in `POST /:id/messages`).
 *
 * Decision doc §8 [D9] + fleet/CHAT-PARITY.md: "octogent-native title derived from
 * ConversationSessionSummary.firstUserTurnPreview (auto-title folds in here); the legacy LLM title
 * is a nicety, not a dependency." The legacy engine had TWO title paths — a smart LLM headline
 * (generate-title) and a first-message slice (auto-title). octogent DROPS the LLM and FOLDS both
 * into one deterministic derivation from the first user turn:
 *
 *   deriveConversationTitle — the legacy auto-title logic (first line of the first user turn,
 *   whitespace-normalized, length-gated, bounded with an ellipsis). No LLM.
 *
 *   resolveConversationTitle — the read-time precedence: an explicitly stored title (set by rename
 *   or an explicit generate-title, persisted in the metadata sidecar) wins; otherwise the derived
 *   auto-title; otherwise null. This is the "auto-title folds in" behavior — a titled-looking
 *   conversation appears automatically from its first turn, no LLM call and no explicit trigger.
 *
 * This module performs NO I/O. The sidecar persistence (an explicit generate-title that PINS the
 * derived title) lives in apps/api (`runtime.generateConversationTitle`).
 */

/** Below this first-turn length, no auto-title is derived (legacy auto-title used a >=10 gate). */
export const MIN_DERIVED_TITLE_SOURCE_LENGTH = 10;

/** Upper bound on a derived title before it is truncated with an ellipsis. */
export const MAX_DERIVED_TITLE_LENGTH = 72;

/**
 * Derive an auto-title from the conversation's first user turn (or its preview). Returns the first
 * line, whitespace-normalized and trimmed; null when there is no first turn or it is shorter than
 * MIN_DERIVED_TITLE_SOURCE_LENGTH (parity with the legacy auto-title's length gate). Titles longer
 * than MAX_DERIVED_TITLE_LENGTH are truncated with a trailing ellipsis.
 */
export const deriveConversationTitle = (firstUserTurnPreview: string | null): string | null => {
  if (typeof firstUserTurnPreview !== "string") {
    return null;
  }

  const firstLine = firstUserTurnPreview.split(/\r?\n/)[0] ?? "";
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  if (normalized.length < MIN_DERIVED_TITLE_SOURCE_LENGTH) {
    return null;
  }

  if (normalized.length <= MAX_DERIVED_TITLE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_DERIVED_TITLE_LENGTH - 1).trimEnd()}…`;
};

export type ResolveConversationTitleInput = {
  /** An explicitly stored title (rename / pinned generate-title), or null. */
  storedTitle: string | null;
  /** The conversation's first user turn preview, for the auto-title fold. */
  firstUserTurnPreview: string | null;
};

/**
 * Resolve the conversation's display title: an explicitly stored (non-blank) title wins, otherwise
 * the auto-derived title from the first user turn, otherwise null. This is the read-time precedence
 * the conversation summary surfaces.
 */
export const resolveConversationTitle = ({
  storedTitle,
  firstUserTurnPreview,
}: ResolveConversationTitleInput): string | null => {
  if (typeof storedTitle === "string" && storedTitle.trim().length > 0) {
    return storedTitle;
  }

  return deriveConversationTitle(firstUserTurnPreview);
};
