/**
 * Create-conversation adapter — pure domain for the #45 W-ORCH-NATIVE Phase 3 [D9] chat "start a
 * conversation" parity (the retiring :3001 dashboard Chat's `POST /`).
 *
 * Decision doc §8 [D9] + fleet/CHAT-PARITY.md: the daily-used dashboard Chat is SUPERSEDED by an
 * octogent-native chat surface. Legacy `POST /` creates a conversation bound to an AGENT (400
 * "agent_id is required" when absent) and returns it 201. Tentacles ARE Claude Code sessions
 * ([D8]), so the octogent-native form of "start a conversation" is: create a chat session bound
 * to a tentacle terminal — i.e. `runtime.createTerminal({ initialPrompt, ... })`, which spawns a
 * LIVE Claude Code session (createTerminal only starts a session when an `initialPrompt` is set).
 *
 * This module is the framework-agnostic contract that normalizes + validates a create-conversation
 * request into the terminal-create params. It performs NO I/O and starts no session — the terminal
 * spawn lives in apps/api (ports-and-adapters boundary): `runtime.createConversation` composes this
 * contract over the existing `createTerminal` primitive.
 *
 * The one required field is `initialPrompt`: without it `createTerminal` records a terminal but
 * never starts a live session, so the conversation could not receive a chat turn (send-message
 * needs a live session). Requiring it is the honest octogent analog of legacy's required
 * `agent_id` — you must say what starts the chat — grounded in octogent's own createTerminal
 * behavior, not invented.
 */

/** A tentacle chat session's workspace mode (mirrors TentacleWorkspaceMode in apps/api). */
export type CreateConversationWorkspaceMode = "shared" | "worktree";

export type CreateConversationInput = {
  /** The seed prompt that starts the tentacle's Claude Code session (legacy: the bound agent). */
  initialPrompt?: unknown;
  /** Optional conversation label → the tentacle name (legacy: the "Chat with <agent>" title). */
  title?: unknown;
  /** Optional workspace mode; defaults to "shared" (an in-place chat, not a worktree). */
  workspaceMode?: unknown;
};

/** The validated + normalized params to hand straight to `runtime.createTerminal`. */
export type NormalizedCreateConversation = {
  initialPrompt: string;
  workspaceMode: CreateConversationWorkspaceMode;
  /** Present only when a non-empty title was supplied. */
  tentacleName?: string;
};

export class CreateConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateConversationError";
  }
}

const CREATE_CONVERSATION_WORKSPACE_MODES: readonly CreateConversationWorkspaceMode[] = [
  "shared",
  "worktree",
];

/**
 * Validate a create-conversation request and normalize it into terminal-create params. Throws
 * CreateConversationError for a missing/empty/non-string `initialPrompt` (parity with legacy's 400
 * "agent_id is required") or an unrecognized `workspaceMode`. `title` is optional; when a non-empty
 * string is supplied it becomes the tentacle name, otherwise createTerminal auto-names the session.
 */
export const buildCreateConversationRequest = (
  input: CreateConversationInput,
): NormalizedCreateConversation => {
  const { initialPrompt, title, workspaceMode } = input;

  if (typeof initialPrompt !== "string" || initialPrompt.trim().length === 0) {
    throw new CreateConversationError("initialPrompt is required");
  }

  let normalizedMode: CreateConversationWorkspaceMode = "shared";
  if (workspaceMode !== undefined && workspaceMode !== null) {
    if (
      typeof workspaceMode !== "string" ||
      !CREATE_CONVERSATION_WORKSPACE_MODES.includes(
        workspaceMode as CreateConversationWorkspaceMode,
      )
    ) {
      throw new CreateConversationError(
        `workspaceMode must be one of: ${CREATE_CONVERSATION_WORKSPACE_MODES.join(", ")}`,
      );
    }
    normalizedMode = workspaceMode as CreateConversationWorkspaceMode;
  }

  const normalized: NormalizedCreateConversation = {
    initialPrompt: initialPrompt.trim(),
    workspaceMode: normalizedMode,
  };

  if (title !== undefined && title !== null) {
    if (typeof title !== "string") {
      throw new CreateConversationError("title must be a string");
    }
    const trimmedTitle = title.trim();
    if (trimmedTitle.length > 0) {
      normalized.tentacleName = trimmedTitle;
    }
  }

  return normalized;
};
