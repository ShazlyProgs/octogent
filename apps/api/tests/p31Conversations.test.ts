import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listConversationSessions } from "../src/terminalRuntime/conversations";

describe("P31 conversation grouping", () => {
  it("uses the current registry tentacle and the latest provider session for previews", () => {
    const dir = mkdtempSync(join(tmpdir(), "p31-conv-"));
    const ev = (n: number, type: string, ts: string, tentacleId: string) =>
      JSON.stringify({ eventId: "terminal-5:" + n, sessionId: "terminal-5", tentacleId, timestamp: ts, type });
    writeFileSync(join(dir, "terminal-5.jsonl"), [
      ev(1, "session_start", "2026-07-19T18:00:00.000Z", "fleet-cpo"),
      ev(2, "input_submit", "2026-07-19T18:01:00.000Z", "fleet-cpo"),
      ev(3, "session_start", "2026-10-31T19:00:00.000Z", "fleet-ciso"),
      ev(4, "input_submit", "2026-10-31T19:01:00.000Z", "fleet-ciso"),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "terminal-5.claude-turns.json"), JSON.stringify([
      { turnId: "a", role: "user", content: "You are fleet-cpo", startedAt: "2026-07-19T18:01:00.000Z", endedAt: "2026-07-19T18:01:05.000Z" },
      { turnId: "b", role: "assistant", content: "ok", startedAt: "2026-07-19T18:01:06.000Z", endedAt: "2026-07-19T18:01:09.000Z" },
      { turnId: "c", role: "user", content: "You are fleet-ciso", startedAt: "2026-10-31T19:01:00.000Z", endedAt: "2026-10-31T19:01:05.000Z" },
    ]));
    const [row] = listConversationSessions(dir, (id) =>
      id === "terminal-5" ? { tentacleId: "fleet-ciso", tentacleName: "CISO", providerSessionId: "62aeff3e-8c04-4faf-89da-daa88ce95667" } : null);
    expect(row?.tentacleId).toBe("fleet-ciso");
    expect(row?.tentacleName).toBe("CISO");
    expect(row?.providerSessionId).toBe("62aeff3e-8c04-4faf-89da-daa88ce95667");
    expect(row?.providerSessionCount).toBe(2);
    expect(row?.firstUserTurnPreview).toBe("You are fleet-ciso");
  });
});
