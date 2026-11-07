import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveCodexTruth, readCodexTurnTail } from "../src/terminalRuntime/logTruth";

const ev = (type: string, ts: string) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type, turn_id: "t1" } });
const filler = (bytes: number) => {
  const line = JSON.stringify({ timestamp: "2026-11-02T12:00:00.000Z", type: "response_item", payload: { type: "message", text: "x".repeat(4000) } });
  return Array.from({ length: Math.ceil(bytes / line.length) }, () => line).join("\n");
};
const write = (body: string) => { const p = join(mkdtempSync(join(tmpdir(), "p31b-")), "rollout.jsonl"); writeFileSync(p, body + "\n"); return p; };

describe("P31b Codex backward scan", () => {
  it("finds a task_started beyond the last 512 KB -> working", () => {
    const p = write([ev("task_complete", "2026-11-02T11:00:00Z"), ev("task_started", "2026-11-02T12:00:00Z"), filler(2 * 1024 * 1024)].join("\n"));
    const t = deriveCodexTruth(readCodexTurnTail(p));
    expect(t.state).toBe("working");
    expect(t.eventAt).toBe("2026-11-02T12:00:00Z");
  });
  it("finds a task_complete beyond the last 512 KB -> idle", () => {
    const p = write([ev("task_started", "2026-11-02T11:00:00Z"), ev("task_complete", "2026-11-02T12:00:00Z"), filler(1536 * 1024)].join("\n"));
    expect(deriveCodexTruth(readCodexTurnTail(p)).state).toBe("idle");
  });
  it("gives unknown when no marker appears before the cap", () => {
    const p = write([ev("task_started", "2026-11-02T11:00:00Z"), filler(3 * 1024 * 1024)].join("\n"));
    expect(readCodexTurnTail(p, 512 * 1024, 1024 * 1024)).toBeNull();
    expect(deriveCodexTruth(readCodexTurnTail(p, 512 * 1024, 1024 * 1024)).state).toBe("unknown");
  });
  it("still reads a marker inside the last chunk", () => {
    const p = write([filler(10 * 1024), ev("task_started", "2026-11-02T12:00:00Z")].join("\n"));
    expect(deriveCodexTruth(readCodexTurnTail(p)).state).toBe("working");
  });
});
