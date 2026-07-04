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

  it("keeps the chat turn (send-message) as a PROVEN adapter (Phase 3 m2), not native or dropped", () => {
    const sendMessage = findChatParityCapability("send-message");
    expect(sendMessage).toBeDefined();
    // Still an adapter (thin octogent-native wiring over existing primitives), but now landed +
    // verified, so its parity is proven — the keystone milestone.
    expect(sendMessage?.disposition).toBe("adapter");
    expect(sendMessage?.parityProven).toBe(true);
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

  it("computes the D9 retire gate honestly from the live matrix (retireReady ⇔ no pending adapters)", () => {
    const caps = getChatParityCapabilities();
    const summary = summarizeChatParity();
    expect(summary.total).toBe(caps.length);
    expect(summary.native + summary.adapter + summary.drop).toBe(summary.total);

    // pendingAdapters is EXACTLY the adapter rows whose parity is not yet proven — the honesty-
    // load-bearing D9 gate. This assertion tracks the live matrix as Phase 3 milestones land, so
    // a false flip (proven:true without a real adapter) would be caught here rather than papered
    // over by a hard-coded count.
    const expectedPending = caps
      .filter((cap) => cap.disposition === "adapter" && !cap.parityProven)
      .map((cap) => cap.id);
    expect(summary.pendingAdapters).toEqual(expectedPending);
    // The gate opens (retireReady) if and only if nothing is pending.
    expect(summary.retireReady).toBe(summary.pendingAdapters.length === 0);
    // send-message (the Phase 3 m2 keystone) stays proven, so it is never pending.
    expect(summary.pendingAdapters).not.toContain("send-message");
  });

  it("marks attach-document PROVEN (Phase 3 m8) — store + live-agent delivery closes the last adapter", () => {
    const attach = findChatParityCapability("attach-document");
    expect(attach).toBeDefined();
    expect(attach?.disposition).toBe("adapter");
    expect(attach?.parityProven).toBe(true);
    expect(attach?.legacyRoute).toBe("POST /:id/upload");
    // With attach-document proven, no adapters remain pending and the D9 retire gate opens.
    const summary = summarizeChatParity();
    expect(summary.pendingAdapters).toEqual([]);
    expect(summary.retireReady).toBe(true);
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
