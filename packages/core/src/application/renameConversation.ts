/**
 * Rename-conversation adapter — pure domain for the #45 W-ORCH-NATIVE Phase 3 [D9] chat "rename /
 * update conversation metadata" parity (the retiring :3001 dashboard Chat's `PUT /:id`).
 *
 * Decision doc §8 [D9] + fleet/CHAT-PARITY.md. Legacy `PUT /:id` calls `updateConversation(id,
 * body)` (title / status / model / agent_id) and returns the updated conversation. The octogent
 * parity is a **session-metadata rename over the transcript store, with NO LLM**: octogent
 * conversations are tentacle-session transcripts, so a "rename" persists a title in a metadata
 * sidecar alongside the transcript and surfaces it on the conversation summary.
 *
 * This module is the framework-agnostic contract for the ONE piece the rename needs to validate:
 * the new title. It performs NO I/O — the sidecar write + the existence check live in apps/api
 * (`runtime.renameConversation` over the transcript-store metadata). A blank/whitespace-only title
 * is rejected (parity with the legacy "required field" 400 shape), mirroring how send-message
 * rejects blank content.
 */

/** The validated conversation title to persist. */
export type ConversationRename = {
  /** The trimmed title to store in the conversation-metadata sidecar. */
  title: string;
};

export class ConversationRenameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationRenameError";
  }
}

/** Upper bound on a stored title — keeps the sidecar bounded and matches UI-list expectations. */
export const CONVERSATION_TITLE_MAX_LENGTH = 200;

/**
 * Validate a rename request and normalize the title. Throws ConversationRenameError for a
 * missing/empty/non-string title (parity with legacy's required-field 400). The stored title is
 * trimmed and capped at CONVERSATION_TITLE_MAX_LENGTH.
 */
export const buildConversationRename = (title: unknown): ConversationRename => {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new ConversationRenameError("title is required");
  }

  const trimmed = title.trim();
  const bounded =
    trimmed.length > CONVERSATION_TITLE_MAX_LENGTH
      ? trimmed.slice(0, CONVERSATION_TITLE_MAX_LENGTH)
      : trimmed;

  return { title: bounded };
};
