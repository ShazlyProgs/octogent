import { describe, expect, it } from "vitest";

import {
  SEND_MESSAGE_BRACKETED_PASTE_END,
  SEND_MESSAGE_BRACKETED_PASTE_START,
  SendMessageError,
  buildConversationInputSubmit,
  resolveSendMessageDisposition,
} from "../src/application/sendMessage";

describe("send-message adapter (#45 Phase 3 [D9] chat-turn keystone)", () => {
  describe("buildConversationInputSubmit — content validation + PTY payload", () => {
    it("rejects empty / whitespace-only / non-string content with the legacy 400 message", () => {
      // Legacy conversations.ts: `if (!content?.trim()) → 400 "content is required"`.
      expect(() => buildConversationInputSubmit("")).toThrow(SendMessageError);
      expect(() => buildConversationInputSubmit("   \n\t ")).toThrow(SendMessageError);
      expect(() => buildConversationInputSubmit(undefined)).toThrow(SendMessageError);
      expect(() => buildConversationInputSubmit(null)).toThrow(SendMessageError);
      expect(() => buildConversationInputSubmit(42)).toThrow(SendMessageError);
      expect(() => buildConversationInputSubmit("")).toThrow("content is required");
    });

    it("trims the turn text and wraps it in bracketed paste + a trailing carriage return", () => {
      const submit = buildConversationInputSubmit("  Ship the launch notes  ");
      // The transcript records the trimmed text (the user turn).
      expect(submit.text).toBe("Ship the launch notes");
      // The PTY payload is the atomic-paste + CR submit — identical to channelMessaging's format.
      expect(submit.submitPayload).toBe(
        `${SEND_MESSAGE_BRACKETED_PASTE_START}Ship the launch notes${SEND_MESSAGE_BRACKETED_PASTE_END}\r`,
      );
      expect(submit.submitPayload.startsWith(SEND_MESSAGE_BRACKETED_PASTE_START)).toBe(true);
      expect(submit.submitPayload.endsWith(`${SEND_MESSAGE_BRACKETED_PASTE_END}\r`)).toBe(true);
    });

    it("uses the exact bracketed-paste markers the channel-messaging PTY path uses", () => {
      // Guards against drift from apps/api/src/terminalRuntime/channelMessaging.ts.
      expect(SEND_MESSAGE_BRACKETED_PASTE_START).toBe("\x1b[200~");
      expect(SEND_MESSAGE_BRACKETED_PASTE_END).toBe("\x1b[201~");
    });

    it("keeps multi-line content intact inside a single atomic paste (no per-line submit)", () => {
      const submit = buildConversationInputSubmit("line one\nline two\nline three");
      expect(submit.text).toBe("line one\nline two\nline three");
      // Exactly one trailing CR (the single submit) — interior newlines are NOT carriage returns.
      expect(submit.submitPayload.match(/\r/g)?.length).toBe(1);
      expect(submit.submitPayload).toContain("line one\nline two\nline three");
    });
  });

  describe("resolveSendMessageDisposition — the per-conversation processing lock (B.14)", () => {
    it("is ready when a live session exists and is idle", () => {
      expect(resolveSendMessageDisposition({ present: true, runtimeState: "idle" })).toBe("ready");
    });

    it("is busy when the session is already processing a turn (legacy 409 concurrent-send guard)", () => {
      expect(resolveSendMessageDisposition({ present: true, runtimeState: "processing" })).toBe(
        "busy",
      );
    });

    it("is busy when the session is blocked on a permission gate (a chat turn would corrupt it)", () => {
      expect(
        resolveSendMessageDisposition({ present: true, runtimeState: "waiting_for_permission" }),
      ).toBe("busy");
    });

    it("is ready when the turn is complete and the session awaits the user (waiting_for_user)", () => {
      expect(
        resolveSendMessageDisposition({ present: true, runtimeState: "waiting_for_user" }),
      ).toBe("ready");
    });

    it("is no-session when no live tentacle session exists to receive the message (legacy 404)", () => {
      expect(resolveSendMessageDisposition({ present: false, runtimeState: null })).toBe(
        "no-session",
      );
      // present:false wins even if a stale runtimeState is supplied.
      expect(resolveSendMessageDisposition({ present: false, runtimeState: "idle" })).toBe(
        "no-session",
      );
    });

    it("treats a present session with unknown (null) runtime state as ready, not busy", () => {
      expect(resolveSendMessageDisposition({ present: true, runtimeState: null })).toBe("ready");
    });
  });
});
