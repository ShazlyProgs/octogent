import { describe, expect, it } from "vitest";
import { decideLogTruthAction, deriveClaudeTruth, deriveCodexTruth, displayState, gateVerdict, logTruthMode, notifyMatches } from "../src/terminalRuntime/logTruth";

const ev = (type: string, ts: string, extra: object = {}) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type, ...extra } });
const started = ev("task_started", "2026-11-02T10:19:48Z", { turn_attribution: { turn_id: "T1" } });
const done = ev("task_complete", "2026-11-02T10:31:54Z", { root_turn_id: "T1" });
const compact = JSON.stringify({ timestamp: "2026-11-02T10:23:59Z", type: "compacted", payload: {} });
const latch = (o = {}) => ({ turnId: "T1", submittedAt: "2026-11-02T10:19:00Z", timedOut: false, unqualifiedReason: null, ...o });

describe("P27 log truth", () => {
  it("flag off by default, shadow when on", () => {
    expect(logTruthMode({})).toBe("off");
    expect(logTruthMode({ OCTO_LOG_TRUTH: "1" })).toBe("shadow");
  });
  it("complete => idle and resolves latch", () => {
    const t = deriveCodexTruth([started, compact, done].join("\n"));
    expect(t.state).toBe("idle");
    expect(decideLogTruthAction(latch(), t).kind).toBe("resolve-turn");
  });
  it("aborted => idle", () => expect(deriveCodexTruth([started, ev("turn_aborted", "2026-11-02T10:25:00Z")].join("\n")).state).toBe("idle"));
  it("compaction mid-turn stays working", () => {
    const t = deriveCodexTruth([started, compact].join("\n"));
    expect(t.state).toBe("working");
    expect(decideLogTruthAction(latch(), t).kind).toBe("none");
  });
  it("missing notify: stale complete before submit does not resolve", () => {
    expect(decideLogTruthAction(latch({ submittedAt: "2026-11-02T11:00:00Z" }), deriveCodexTruth(done)).kind).toBe("none");
  });
  it("generation change: notify still matches by turnId when flag on", () => {
    expect(notifyMatches({ turnId: "T1", generation: 1 }, { turnId: "T1", generation: 2 }, { OCTO_LOG_TRUTH: "1" })).toBe(true);
    expect(notifyMatches({ turnId: "T1", generation: 1 }, { turnId: "T1", generation: 2 }, {})).toBe(false);
  });
  it("completion-unverified hold is released from log truth", () => {
    const a = decideLogTruthAction(latch({ turnId: null, unqualifiedReason: "completion-unverified" }), deriveCodexTruth(done));
    expect(a).toMatchObject({ kind: "unhold", state: "idle" });
  });
  it("hold with a different reason stays held", () => {
    for (const r of ["full-access", "permission-prompt", "release-hold-token"])
      expect(decideLogTruthAction(latch({ unqualifiedReason: r }), deriveCodexTruth(done)).kind).toBe("none");
  });
  it("timeout shows unknown, never processing; gate says check-log", () => {
    const d = displayState("processing", latch({ timedOut: true }), deriveCodexTruth(null), Date.now(), 0);
    expect(d.state).toBe("unknown");
    expect(gateVerdict(d.state)).toBe("check-log");
  });
  it("exposes stateSource and stateAgeSec", () => {
    const d = displayState("processing", latch(), deriveCodexTruth(done), Date.parse("2026-11-02T10:32:54Z"), 0);
    expect(d).toEqual({ state: "idle", stateSource: "log", stateAgeSec: 60 });
  });
  it("Claude transcript: tool_result is not a new prompt; end_turn => idle", () => {
    const u = JSON.stringify({ type: "user", timestamp: "2026-11-02T10:00:00Z", message: { content: "go" } });
    const tr = JSON.stringify({ type: "user", timestamp: "2026-11-02T10:01:00Z", message: { content: [{ type: "tool_result" }] } });
    const a = JSON.stringify({ type: "assistant", timestamp: "2026-11-02T10:02:00Z", message: { stop_reason: "end_turn" } });
    expect(deriveClaudeTruth([u, tr].join("\n")).state).toBe("working");
    expect(deriveClaudeTruth([u, tr, a].join("\n")).state).toBe("idle");
  });
});
