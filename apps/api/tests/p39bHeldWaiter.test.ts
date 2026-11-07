import { describe, expect, it } from "vitest";
import { seatDoneHeldDecision, isSeatDoneStale, codexLastTurnTimes, isCompletionNotifyHeldOkEnabled, completionSettleWaiterMs, type SeatDoneFacts } from "../src/terminalRuntime/completionNotify";
import { createChannelMessaging } from "../src/terminalRuntime/channelMessaging";

const NOW = Date.parse("2026-11-04T19:40:00Z");
const held = (o: Partial<SeatDoneFacts> = {}): SeatDoneFacts => ({ provider: "codex", agentState: "held", unqualified: true, holdReason: "completion-unverified", timedOut: false,
  logState: "idle", lastEvent: "task_complete", lastCompleteAtMs: NOW - 60_000, lastTurnStartedAtMs: NOW - 120_000, heldActivity: false, pendingInput: false,
  lastInputAtMs: NOW - 120_000, nowMs: NOW, settleMs: 15_000, ...o });

describe("P39b held-waiter gate", () => {
  it("flags default off; settle default 15 s", () => {
    expect(isCompletionNotifyHeldOkEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCompletionNotifyHeldOkEnabled({ OCTO_COMPLETION_NOTIFY: "1", OCTO_COMPLETION_NOTIFY_TYPE: "1", OCTO_COMPLETION_NOTIFY_HELD_OK: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(completionSettleWaiterMs({} as NodeJS.ProcessEnv)).toBe(15_000);
  });
  it("held Codex seat with idle log -> deliver", () => { expect(seatDoneHeldDecision(held())).toBe("deliver"); });
  it("busy/processing seat held back", () => {
    expect(seatDoneHeldDecision(held({ logState: "processing", lastEvent: "task_started" }))).toBe("wait");
    expect(seatDoneHeldDecision(held({ heldActivity: true }))).toBe("wait");
    expect(seatDoneHeldDecision(held({ pendingInput: true }))).toBe("wait");
  });
  it("recent typing/delivery (<10 s) held back", () => { expect(seatDoneHeldDecision(held({ lastInputAtMs: NOW - 5_000 }))).toBe("wait"); });
  it("settle wait after task_complete", () => {
    expect(seatDoneHeldDecision(held({ lastCompleteAtMs: NOW - 5_000 }))).toBe("wait");
    expect(seatDoneHeldDecision(held({ lastCompleteAtMs: NOW - 16_000 }))).toBe("deliver");
  });
  it("only the releasable completion-unverified hold; never a timed-out turn", () => {
    expect(seatDoneHeldDecision(held({ holdReason: "effective-provider-unknown" }))).toBe("wait");
    expect(seatDoneHeldDecision(held({ timedOut: true }))).toBe("wait");
  });
  it("Claude seats and non-held seats unaffected", () => {
    expect(seatDoneHeldDecision(held({ provider: "claude-code" }))).toBe("not-held");
    expect(seatDoneHeldDecision(held({ agentState: "idle" }))).toBe("not-held");
    expect(isSeatDoneStale(held({ provider: "claude-code", lastTurnStartedAtMs: NOW }), NOW - 1)).toBe(false);
  });
  it("stale: waiter started and finished a turn after the ping was queued (msg-325 case)", () => {
    const queued = Date.parse("2026-11-04T19:29:35.594Z");
    const f = held({ lastTurnStartedAtMs: Date.parse("2026-11-04T19:32:05.986Z"), lastCompleteAtMs: Date.parse("2026-11-04T19:34:31.910Z") });
    expect(isSeatDoneStale(f, queued)).toBe(true);
    expect(isSeatDoneStale(held({ lastTurnStartedAtMs: queued - 60_000 }), queued)).toBe(false); // busy at queue time -> deliver after turn
  });
  it("codexLastTurnTimes reads the last start/complete", () => {
    const j = (t: string, ts: string) => JSON.stringify({ type: "event_msg", timestamp: ts, payload: { type: t } });
    const r = codexLastTurnTimes([j("task_started", "2026-11-04T19:32:05Z"), j("task_complete", "2026-11-04T19:34:31Z")].join("\n"));
    expect(r.startedAtMs).toBe(Date.parse("2026-11-04T19:32:05Z")); expect(r.completedAtMs).toBe(Date.parse("2026-11-04T19:34:31Z"));
  });
});

describe("P39b channel integration", () => {
  const setup = (release: boolean, staleIds: string[] = []) => {
    const terminals = new Map<string, any>([["terminal-17", { terminalId: "terminal-17", tentacleName: "VaultAgent" }], ["terminal-5", { terminalId: "terminal-5", tentacleName: "CISO" }]]);
    const session: any = { agentState: "held" }; const sessions = new Map<string, any>([["terminal-17", session]]);
    const writes: string[] = [];
    const ch = createChannelMessaging({ terminals, sessions, writeInput: (_id: string, d: string) => { writes.push(d); return true; },
      beforeDeliver: (_id: string, p: any[]) => p.filter((m: any) => staleIds.includes(m.messageId)).map((m: any) => m.messageId),
      releaseHeldForPings: () => { if (release) session.agentState = "idle"; return release; } } as any);
    return { ch, session, writes };
  };
  it("held waiter: ping stays queued while gate says wait, typed once released", () => {
    const a = setup(false); const m = a.ch.sendChannelMessage("terminal-17", "terminal-5", "SEAT DONE: CISO, t1, result: r.md")!;
    a.ch.deliverChannelMessages("terminal-17"); expect(a.writes).toHaveLength(0); expect(m.delivered).toBe(false);
    const b = setup(true); const m2 = b.ch.sendChannelMessage("terminal-17", "terminal-5", "SEAT DONE: CISO, t1, result: r.md")!;
    b.ch.deliverChannelMessages("terminal-17"); expect(b.writes).toHaveLength(1); expect(b.writes[0]).toContain("SEAT DONE: CISO, t1"); expect(m2.delivered).toBe(true);
  });
  it("stale ping superseded, never typed", () => {
    const a = setup(true, ["msg-1"]); const m = a.ch.sendChannelMessage("terminal-17", "terminal-5", "SEAT DONE: CISO, old, result: r.md")!;
    expect(m.messageId).toBe("msg-1"); a.ch.deliverChannelMessages("terminal-17");
    expect(a.writes).toHaveLength(0); expect(m.superseded?.reason).toBe("seat-done-stale");
  });
});

// P39c-wired:tests
import { seatDonePingsToSupersede, isSeatDoneStaleByTimes, claudeLastTurnTimes } from "../src/terminalRuntime/completionNotify";
describe("P39c times-only staleness", () => {
  const Q = Date.parse("2026-11-04T19:29:35.594Z");
  const ping = { messageId: "msg-325", content: "SEAT DONE: CISO, compose-r4, result: r.md", timestamp: "2026-11-04T19:29:35.594Z" };
  it("exact misfire: full waiter turn after queue, restart+resume -> plain idle, no logState -> superseded, not typed", () => {
    const facts = held({ agentState: "idle", unqualified: false, holdReason: null, logState: "unknown", lastEvent: null,
      lastTurnStartedAtMs: Date.parse("2026-11-04T19:32:05.986Z"), lastCompleteAtMs: Date.parse("2026-11-04T19:34:31.910Z") });
    expect(seatDonePingsToSupersede([ping], facts).map((m) => m.messageId)).toEqual(["msg-325"]);
    const terminals = new Map<string, any>([["terminal-17", { terminalId: "terminal-17" }], ["terminal-5", { terminalId: "terminal-5" }]]);
    const session: any = { agentState: "idle" }; const sessions = new Map<string, any>([["terminal-17", session]]); const writes: string[] = [];
    const ch = createChannelMessaging({ terminals, sessions, writeInput: (_i: string, d: string) => { writes.push(d); return true; },
      beforeDeliver: (_i: string, p: any[]) => seatDonePingsToSupersede(p.map((m) => ({ ...m, timestamp: new Date(Q).toISOString() })), facts).map((m) => m.messageId) } as any);
    const m = ch.sendChannelMessage("terminal-17", "terminal-5", ping.content)!; ch.deliverChannelMessages("terminal-17");
    expect(writes).toHaveLength(0); expect(m.delivered).toBe(false); expect(m.superseded?.reason).toBe("seat-done-stale");
  });
  it("not stale: waiter busy at queue time (turn started before), or turn still running", () => {
    expect(isSeatDoneStaleByTimes({ lastTurnStartedAtMs: Q - 60_000, lastCompleteAtMs: Q + 60_000 }, Q)).toBe(false);
    expect(isSeatDoneStaleByTimes({ lastTurnStartedAtMs: Q + 1_000, lastCompleteAtMs: null }, Q)).toBe(false);
    expect(seatDonePingsToSupersede([ping], null)).toEqual([]);
    expect(seatDonePingsToSupersede([{ ...ping, content: "hello" }], { lastTurnStartedAtMs: Q + 1, lastCompleteAtMs: Q + 2 })).toEqual([]);
  });
  it("claude turn times skip tool_result and compact summaries", () => {
    const L = (o: any) => JSON.stringify(o);
    const tail = [L({ type: "user", timestamp: "2026-11-04T19:30:00Z", message: { content: "go" } }),
      L({ type: "user", timestamp: "2026-11-04T19:30:10Z", message: { content: [{ type: "tool_result" }] } }),
      L({ type: "assistant", timestamp: "2026-11-04T19:31:00Z", message: { stop_reason: "end_turn" } }),
      L({ type: "user", timestamp: "2026-11-04T19:32:00Z", isCompactSummary: true, message: { content: "sum" } })].join("\n");
    expect(claudeLastTurnTimes(tail)).toEqual({ startedAtMs: Date.parse("2026-11-04T19:30:00Z"), completedAtMs: Date.parse("2026-11-04T19:31:00Z") });
    expect(isSeatDoneStaleByTimes({ lastTurnStartedAtMs: Date.parse("2026-11-04T19:30:00Z"), lastCompleteAtMs: Date.parse("2026-11-04T19:31:00Z") }, Q)).toBe(true);
  });
});