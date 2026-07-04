/**
 * Send-message adapter — pure domain for the #45 W-ORCH-NATIVE Phase 3 [D9] chat "send a
 * message" KEYSTONE (the retiring :3001 dashboard Chat's `POST /:id/messages`, the chat turn).
 *
 * Decision doc §8 [D9] + fleet/CHAT-PARITY.md: the daily-used dashboard Chat is SUPERSEDED by
 * an octogent-native chat surface. Tentacles ARE Claude Code sessions ([D8]), so the chat turn
 * is NOT "call claude-client.ts and return a reply" (the legacy engine path) — it is: submit the
 * user's message into the tentacle's live terminal session, then surface the reply through the
 * ALREADY-NATIVE transcript read (GET /api/conversations/:id). This module is the framework-
 * agnostic contract for the SUBMIT + LOCK half of that turn:
 *
 *   1. Validate the turn content (legacy: `if (!content?.trim())` → 400 "content is required").
 *   2. Resolve the per-conversation processing LOCK from the session runtime state — the octogent-
 *      native form of the legacy in-memory `conversationLocks` map (B.14): a conversation that is
 *      already `processing` a turn must reject a concurrent send (legacy 409).
 *   3. Build the exact terminal input-submit payload the tentacle PTY expects — the SAME
 *      bracketed-paste + carriage-return shape the proven channel-messaging path already uses
 *      (apps/api/src/terminalRuntime/channelMessaging.ts) so multi-line content lands atomically
 *      and the trailing \r submits it (Windows ConPTY input-overflow safe).
 *
 * It performs NO I/O and builds no reply. The PTY write, the session lookup, and the transcript
 * recording live in apps/api (ports-and-adapters boundary): terminalRuntime.submitConversationMessage
 * composes this contract over runtime.writeInput + the native transcript surface. The assistant
 * reply is Claude Code's own doing (its Stop hook writes the turns the native read returns).
 */

import type { AgentRuntimeState } from "../domain/agentRuntime";

/** The tentacle session's runtime state, as observed by the terminal runtime. */
export type SendMessageRuntimeState = AgentRuntimeState;

/**
 * Whether a conversation can accept a chat turn right now.
 *  - "ready"      — a live session exists and is idle; submit the turn.
 *  - "busy"       — the session is already processing a turn (the B.14 lock); reject (legacy 409).
 *  - "no-session" — no live tentacle session to receive the message (legacy 404 "not found").
 */
export type SendMessageDisposition = "ready" | "busy" | "no-session";

export type SendMessageSessionState = {
  /** Whether a LIVE terminal session (not just a registry record) exists for the conversation. */
  present: boolean;
  /** The session's agent runtime state, or null when no live session exists. */
  runtimeState: SendMessageRuntimeState | null;
};

/** The validated turn text + the exact PTY payload that submits it into the tentacle session. */
export type ConversationInputSubmit = {
  /** The trimmed turn text (what the transcript records as the user turn). */
  text: string;
  /** Bracketed-paste-wrapped text + trailing \r — hand straight to runtime.writeInput. */
  submitPayload: string;
};

export class SendMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendMessageError";
  }
}

// Bracketed-paste markers — MUST match channelMessaging.ts so the chat turn reaches Claude Code
// through the identical, battle-tested atomic-paste path (not a raw keystroke stream).
export const SEND_MESSAGE_BRACKETED_PASTE_START = "\x1b[200~";
export const SEND_MESSAGE_BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Resolve the per-conversation processing lock (legacy B.14 `conversationLocks`) from the live
 * session runtime state. Pure and honest about the octogent runtime states:
 *  - no live session → no-session (legacy 404).
 *  - "processing" (actively mid-turn) OR "waiting_for_permission" (blocked on a y/n permission
 *    gate — a chat turn here would corrupt the prompt) → busy (legacy 409 concurrent-send guard).
 *  - "idle" / "waiting_for_user" (turn complete, awaiting the next message) / null → ready.
 */
export const resolveSendMessageDisposition = (
  state: SendMessageSessionState,
): SendMessageDisposition => {
  if (!state.present) {
    return "no-session";
  }
  if (state.runtimeState === "processing" || state.runtimeState === "waiting_for_permission") {
    return "busy";
  }
  return "ready";
};

/**
 * Validate a chat turn and build the terminal input-submit payload. Throws SendMessageError for
 * empty/whitespace-only content (legacy: 400 "content is required"). The payload wraps the trimmed
 * text in bracketed paste + a trailing carriage return, mirroring the proven channel-messaging
 * delivery format exactly.
 */
export const buildConversationInputSubmit = (content: unknown): ConversationInputSubmit => {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new SendMessageError("content is required");
  }

  const text = content.trim();
  const submitPayload = `${SEND_MESSAGE_BRACKETED_PASTE_START}${text}${SEND_MESSAGE_BRACKETED_PASTE_END}\r`;

  return { text, submitPayload };
};
