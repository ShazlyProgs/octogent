import { describe, expect, it } from "vitest";

import {
  ChatParityError,
  findChatParityCapability,
  getChatParityCapabilities,
  markChatParityProven,
  summarizeChatParity,
} from "../src/application/chatParity";

describe("chat-parity registry (#45 Phase 3 [D9])", () => {
  it("enumerates the legacy dashboard Chat surface with unique ids + valid dispositions", () => {
    const caps = getChatParityCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    const ids = caps.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cap of caps) {
      expect(["native", "adapter", "drop"]).toContain(cap.disposition);
      expect(cap.legacyRoute.length).toBeGreaterThan(0);
      expect(cap.octogentParity.length).toBeGreaterThan(0);
    }
  });

  it("marks the read/list/delete transcript routes native (parity already proven)", () => {
    const caps = getChatParityCapabilities();
    const native = caps.filter((c) => c.disposition === "native");
    expect(native.map((c) => c.id).sort()).toEqual([
      "delete-conversation",
      "get-conversation",
      "list-conversations",
    ]);
    // Native rows are inherently proven.
    for (const cap of native) expect(cap.parityProven).toBe(true);
  });

  it("keeps the chat turn (send-message) as an unproven adapter, not native or dropped", () => {
    const sendMessage = findChatParityCapability("send-message");
    expect(sendMessage).toBeDefined();
    expect(sendMessage?.disposition).toBe("adapter");
    expect(sendMessage?.parityProven).toBe(false);
    expect(sendMessage?.legacyRoute).toBe("POST /:id/messages");
  });

  it("drops engine-coupled capabilities (delegate + suggestions + document-search), never re-implements them", () => {
    const caps = getChatParityCapabilities();
    const dropped = caps
      .filter((c) => c.disposition === "drop")
      .map((c) => c.id)
      .sort();
    expect(dropped).toEqual(["delegate-to-agent", "document-search", "reply-suggestions"]);
    // Delegation is superseded by the tentacle-tree topology, not ported.
    const delegate = findChatParityCapability("delegate-to-agent");
    expect(delegate?.octogentParity).toMatch(/tentacle-tree|channel messaging/i);
  });

  it("is NOT retire-ready while adapters are unproven (D9 no-hard-cut gate)", () => {
    const summary = summarizeChatParity();
    expect(summary.total).toBe(getChatParityCapabilities().length);
    expect(summary.native + summary.adapter + summary.drop).toBe(summary.total);
    expect(summary.retireReady).toBe(false);
    // Every unproven adapter is surfaced as remaining Phase 3 work.
    expect(summary.pendingAdapters.length).toBe(summary.adapter);
    expect(summary.pendingAdapters).toContain("send-message");
  });

  it("becomes retire-ready only once every adapter is proven (drops are excluded from the gate)", () => {
    const adapterIds = getChatParityCapabilities()
      .filter((c) => c.disposition === "adapter")
      .map((c) => c.id);
    // Calls compose over the working matrix as each adapter lands.
    const caps = adapterIds.reduce(
      (matrix, id) => markChatParityProven(id, matrix),
      getChatParityCapabilities(),
    );
    const summary = summarizeChatParity(caps);
    expect(summary.pendingAdapters).toEqual([]);
    expect(summary.retireReady).toBe(true);
    // Dropped capabilities stay parityProven:false but do not block the cut.
    expect(caps.filter((c) => c.disposition === "drop").every((c) => !c.parityProven)).toBe(true);
  });

  it("markChatParityProven is immutable and rejects unknown / non-adapter ids", () => {
    const before = getChatParityCapabilities();
    markChatParityProven("send-message");
    // Live registry is untouched (returns a new list).
    expect(getChatParityCapabilities()).toEqual(before);
    expect(() => markChatParityProven("nope")).toThrow(ChatParityError);
    // native + drop rows cannot be "proven" incrementally.
    expect(() => markChatParityProven("list-conversations")).toThrow(ChatParityError);
    expect(() => markChatParityProven("delegate-to-agent")).toThrow(ChatParityError);
  });
});
