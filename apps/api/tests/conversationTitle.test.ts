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

/** Write a transcript with a configurable first user turn so title derivation can be exercised. */
const writeTranscriptFixture = (workspaceCwd: string, sessionId: string, firstUserTurn: string) => {
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
    JSON.stringify([
      {
        turnId: "turn-1",
        role: "user",
        content: firstUserTurn,
        startedAt: "2026-03-05T10:00:01.000Z",
        endedAt: "2026-03-05T10:00:01.000Z",
      },
    ]),
    "utf8",
  );
};

describe("conversation-title adapter — runtime.generateConversationTitle (#45 Phase 3 [D9] m5)", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: Runtime[] = [];

  const createRuntime = (sessionId: string, firstUserTurn: string): Runtime => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-conversation-title-test-"));
    temporaryDirectories.push(workspaceCwd);
    writeTranscriptFixture(workspaceCwd, sessionId, firstUserTurn);
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

  it("auto-derives a title at read from the first user turn (no explicit call, no LLM)", () => {
    const runtime = createRuntime("terminal-1", "draft the launch note for IFAT");
    expect(runtime.readConversationSession("terminal-1")?.title).toBe(
      "draft the launch note for IFAT",
    );
  });

  it("pins the derived title in the sidecar so it is stable (generate-title fold)", () => {
    const runtime = createRuntime("terminal-1", "draft the launch note for IFAT");

    const result = runtime.generateConversationTitle("terminal-1");
    expect(result.status).toBe("titled");
    if (result.status === "titled") {
      expect(result.title).toBe("draft the launch note for IFAT");
    }
    // Now a STORED title exists (pinned) — a subsequent rename still overrides it.
    expect(runtime.readConversationSession("terminal-1")?.title).toBe(
      "draft the launch note for IFAT",
    );
    runtime.renameConversation("terminal-1", "Launch — IFAT");
    expect(runtime.readConversationSession("terminal-1")?.title).toBe("Launch — IFAT");
  });

  it("returns no-title when the first turn is too short to derive a title", () => {
    const runtime = createRuntime("terminal-1", "hi");
    const result = runtime.generateConversationTitle("terminal-1");
    expect(result.status).toBe("no-title");
    // Read likewise has no derivable title.
    expect(runtime.readConversationSession("terminal-1")?.title).toBeNull();
  });

  it("returns no-conversation for an unknown session", () => {
    const runtime = createRuntime("terminal-1", "draft the launch note");
    expect(runtime.generateConversationTitle("nope").status).toBe("no-conversation");
  });
});
