import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node-pty", () => ({ spawn: spawnMock }));

vi.mock("../src/terminalRuntime/ptyEnvironment", () => ({
  createShellEnvironment: vi.fn(() => ({})),
  ensureNodePtySpawnHelperExecutable: vi.fn(),
}));

import { createTerminalRuntime } from "../src/terminalRuntime";
import type { GitClient } from "../src/terminalRuntime";

const noopGitClient = (): GitClient =>
  ({
    assertAvailable() {},
    isRepository: () => true,
  }) as unknown as GitClient;

type Runtime = ReturnType<typeof createTerminalRuntime>;

type TurnFixture = { role: "user" | "assistant"; content: string };

/** Write a transcript with a fixed set of user/assistant turns. */
const writeTranscriptFixture = (workspaceCwd: string, sessionId: string, turns: TurnFixture[]) => {
  const transcriptsDir = join(workspaceCwd, ".octogent", "state", "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  const encoded = encodeURIComponent(sessionId);
  writeFileSync(
    join(transcriptsDir, `${encoded}.jsonl`),
    `${JSON.stringify({
      type: "session_start",
      eventId: `${sessionId}:1`,
      sessionId,
      tentacleId: sessionId,
      timestamp: "2026-03-05T10:00:00.000Z",
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(transcriptsDir, `${encoded}.claude-turns.json`),
    JSON.stringify(
      turns.map((turn, index) => ({
        turnId: `turn-${index + 1}`,
        role: turn.role,
        content: turn.content,
        startedAt: "2026-03-05T10:00:01.000Z",
        endedAt: "2026-03-05T10:00:02.000Z",
      })),
    ),
    "utf8",
  );
};

describe("conversation-summary adapter — runtime.summarizeConversation (#45 Phase 3 [D9] m6)", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: Runtime[] = [];

  const createRuntime = (sessionId: string, turns: TurnFixture[]): Runtime => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-conversation-summary-test-"));
    temporaryDirectories.push(workspaceCwd);
    writeTranscriptFixture(workspaceCwd, sessionId, turns);
    const runtime = createTerminalRuntime({ workspaceCwd, gitClient: noopGitClient() });
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      try {
        await runtime.close();
      } catch {
        // Best-effort teardown.
      }
    }
    runtimes.length = 0;
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("builds a deterministic recap from the transcript counts + previews (no LLM)", () => {
    const runtime = createRuntime("terminal-1", [
      { role: "user", content: "draft the launch note" },
      { role: "assistant", content: "here is a first draft" },
      { role: "user", content: "add the pricing table" },
      { role: "assistant", content: "done — pricing table added" },
    ]);

    const result = runtime.summarizeConversation("terminal-1");
    expect(result.status).toBe("summarized");
    if (result.status !== "summarized") {
      throw new Error("expected summarized");
    }
    expect(result.summary).toContain("4 messages — 2 from the user, 2 from the assistant.");
    expect(result.summary).toContain('Opened with: "draft the launch note".');
    expect(result.summary).toContain('Latest from the user: "add the pricing table".');
    expect(result.summary).toContain('Latest reply: "done — pricing table added".');

    // Two runs of the deterministic summary are byte-identical (no model nondeterminism).
    const again = runtime.summarizeConversation("terminal-1");
    if (again.status === "summarized") {
      expect(again.summary).toBe(result.summary);
    }
  });

  it("returns no-conversation for an unknown session (legacy 404)", () => {
    const runtime = createRuntime("terminal-1", [{ role: "user", content: "hello there" }]);
    expect(runtime.summarizeConversation("nope").status).toBe("no-conversation");
  });
});
