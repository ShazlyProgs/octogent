import { describe, expect, it } from "vitest";
import { deriveClaudeTruth, livenessVerdict, lastClaudePrompt, isClaudeSyntheticUser, seatLivenessMs } from "../src/terminalRuntime/logTruth";
const j = (o: unknown) => JSON.stringify(o);
const realUser = j({ type: "user", timestamp: "2026-11-04T01:59:44Z", uuid: "u1", message: { content: "[Channel message from VaultAgent]: Read DISPATCH-s3-0300" } });
const endTurn = j({ type: "assistant", timestamp: "2026-11-04T02:14:07Z", uuid: "a1", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
const compact = j({ type: "user", timestamp: "2026-11-04T03:09:03Z", uuid: "c1", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: "This session is being continued..." } });
const lastPrompt = j({ type: "last-prompt", lastPrompt: "[Channel message from VaultAgent]: Read DISPATCH-s3-0300" });
describe("P38 Claude synthetic user skip", () => {
  it("bug reproduced with flag off: compaction summary reads as working", () => {
    expect(deriveClaudeTruth([realUser, endTurn, compact].join("\n"), false).state).toBe("working");
  });
  it("flag on: compaction summary ignored, seat idle", () => {
    const t = deriveClaudeTruth([realUser, endTurn, compact].join("\n"), true);
    expect(t.state).toBe("idle"); expect(t.event).toBe("end_turn");
  });
  it("flag on: a real unanswered prompt still reads as working (P37 lost submit stays visible)", () => {
    expect(deriveClaudeTruth([endTurn, realUser, compact].join("\n"), true).state).toBe("working");
  });
  it("classifies meta/transcript-only records", () => {
    expect(isClaudeSyntheticUser({ isMeta: true })).toBe(true); expect(isClaudeSyntheticUser({ type: "user" })).toBe(false);
  });
  it("lastClaudePrompt returns the real delivery, not the summary", () => {
    expect(lastClaudePrompt([realUser, compact, lastPrompt].join("\n"))).toContain("DISPATCH-s3-0300");
  });
});
describe("P38 liveness verdict", () => {
  const base = { display: "processing", logMtimeMs: 0, eventAtMs: 0, ptyQuietMs: 0, nowMs: 10_000_000, thresholdMs: 300_000 };
  it("default threshold is 5 min", () => { expect(seatLivenessMs({} as NodeJS.ProcessEnv)).toBe(300_000); });
  it("stuck when processing, log and pty quiet past threshold", () => {
    expect(livenessVerdict({ ...base, logMtimeMs: 10_000_000 - 400_000, ptyQuietMs: 400_000 })).toBe("stuck");
  });
  it("ok while the log is still growing (real long turn)", () => {
    expect(livenessVerdict({ ...base, logMtimeMs: 10_000_000 - 30_000, ptyQuietMs: 400_000 })).toBe("ok");
  });
  it("ok while the PTY is still printing", () => {
    expect(livenessVerdict({ ...base, logMtimeMs: 10_000_000 - 400_000, ptyQuietMs: 10_000 })).toBe("ok");
  });
  it("never flags idle seats or unreadable logs", () => {
    expect(livenessVerdict({ ...base, display: "idle", logMtimeMs: 1, ptyQuietMs: 9e9 })).toBe("ok");
    expect(livenessVerdict({ ...base, logMtimeMs: null, eventAtMs: null, ptyQuietMs: 9e9 })).toBe("ok");
  });
});
