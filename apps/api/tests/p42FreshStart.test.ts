import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldReconcileLatch, deriveCodexTruth } from "../src/terminalRuntime/logTruth";
import {
  isFreshStartResetSessionEnabled,
  resetSessionIdsForFreshStart,
  discoverCodexThreadId,
  discoverClaudeSessionId,
  isStaleLatchEvent,
} from "../src/terminalRuntime/freshStartSession";

const line = (type: string, ts: string) =>
  JSON.stringify({ type: "event_msg", timestamp: ts, payload: { type } });

describe("P42 fresh-start session reset", () => {
  it("flag defaults off", () => {
    expect(isFreshStartResetSessionEnabled({})).toBe(false);
    expect(isFreshStartResetSessionEnabled({ OCTO_FRESH_START_RESET_SESSION: "1" })).toBe(true);
  });

  it("Codex: clears stale codexThreadId into previousSessionIds on fresh start", () => {
    const t: { codexThreadId?: string; claudeSessionId?: string; previousSessionIds?: any[] } = {
      codexThreadId: "01a192c1-f176-75f3-b5a7-38b196015c98",
      claudeSessionId: "1cd2647c-0ef9-4e57-b3df-ad1fd40d841b",
    };
    expect(resetSessionIdsForFreshStart(t, "2026-11-05T11:01:15.000Z")).toBe(true);
    expect(t.codexThreadId).toBeUndefined();
    expect(t.claudeSessionId).toBeUndefined();
    expect(t.previousSessionIds).toEqual([
      {
        at: "2026-11-05T11:01:15.000Z",
        codexThreadId: "01a192c1-f176-75f3-b5a7-38b196015c98",
        claudeSessionId: "1cd2647c-0ef9-4e57-b3df-ad1fd40d841b",
      },
    ]);
    expect(resetSessionIdsForFreshStart(t)).toBe(false);
  });

  it("Claude-only: archives claudeSessionId", () => {
    const t: { claudeSessionId?: string; previousSessionIds?: any[] } = {
      claudeSessionId: "d7039d25-ce1b-4964-adb1-4250fd6fbdfe",
    };
    expect(resetSessionIdsForFreshStart(t, "2026-11-05T12:00:00.000Z")).toBe(true);
    expect(t.claudeSessionId).toBeUndefined();
    expect(t.previousSessionIds?.[0].claudeSessionId).toBe("d7039d25-ce1b-4964-adb1-4250fd6fbdfe");
  });

  it("discovers new Codex thread id from locks after start", () => {
    const home = mkdtempSync(join(tmpdir(), "p42-codex-"));
    const locks = join(home, ".codex", "thread-writer-locks");
    mkdirSync(locks, { recursive: true });
    const id = "01a1ab5e-c13c-7f81-b0f9-db32a1857519";
    const lockPath = join(locks, `${id}.lock`);
    writeFileSync(lockPath, "");
    const after = Date.now() - 5_000;
    utimesSync(lockPath, new Date(), new Date());
    expect(discoverCodexThreadId({ afterMs: after, home, nowMs: Date.now() })).toBe(id);
    expect(discoverCodexThreadId({ afterMs: Date.now() + 60_000, home })).toBeNull();
  });

  it("discovers new Claude session id from projects jsonl", () => {
    const home = mkdtempSync(join(tmpdir(), "p42-claude-"));
    const dir = join(home, ".claude", "projects", "C--Users-test-Vault");
    mkdirSync(dir, { recursive: true });
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, "{}\n");
    utimesSync(p, new Date(), new Date());
    expect(discoverClaudeSessionId({ afterMs: Date.now() - 5_000, home })).toBe(id);
  });

  it("latch ignores completion events dated before session startedAt (POE misfire)", () => {
    const submit = Date.parse("2026-11-05T11:01:20.779Z");
    const started = Date.parse("2026-11-05T11:01:15.230Z");
    const now = Date.parse("2026-11-05T11:04:28.533Z");
    const stale = deriveCodexTruth(line("task_complete", "2026-10-31T22:19:33.669Z"));
    const base = {
      turnId: "octogent-turn-1-cb81fc78",
      submittedAtMs: submit,
      legacy: "processing",
      truth: stale,
      nowMs: now,
      thresholdMs: 180_000,
    };
    // Without startedAt (pre-P42): would reconcile — that was the bug.
    expect(shouldReconcileLatch(base)).toBe(true);
    // With startedAt: stale event is before this session → ignore.
    expect(shouldReconcileLatch({ ...base, startedAtMs: started })).toBe(false);
    expect(isStaleLatchEvent("2026-10-31T22:19:33.669Z", started)).toBe(true);
    // A completion after start but before submit still reconciles (true delivery miss).
    const recentOld = deriveCodexTruth(line("task_complete", "2026-11-05T11:01:18.000Z"));
    expect(shouldReconcileLatch({ ...base, truth: recentOld, startedAtMs: started })).toBe(true);
  });

  it("resume behaviour unchanged: shouldReconcileLatch without startedAtMs keeps prior rules", () => {
    const now = Date.parse("2026-11-02T19:41:00Z");
    const sub = Date.parse("2026-11-02T19:37:55Z");
    const idleOld = deriveCodexTruth(line("task_complete", "2026-11-02T19:28:01Z"));
    const base = { turnId: "t", submittedAtMs: sub, legacy: "processing", nowMs: now, thresholdMs: 180_000, truth: idleOld };
    expect(shouldReconcileLatch(base)).toBe(true);
    expect(shouldReconcileLatch({ ...base, nowMs: sub + 60_000 })).toBe(false);
    expect(shouldReconcileLatch({ ...base, legacy: "idle" })).toBe(false);
  });
});
