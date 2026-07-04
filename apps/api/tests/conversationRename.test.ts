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

/** Write a minimal on-disk conversation transcript (session_start + one user/assistant turn). */
const writeTranscriptFixture = (workspaceCwd: string, sessionId: string) => {
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
        content: "draft the launch note",
        startedAt: "2026-03-05T10:00:01.000Z",
        endedAt: "2026-03-05T10:00:01.000Z",
      },
    ]),
    "utf8",
  );
};

describe("rename-conversation adapter — runtime.renameConversation (#45 Phase 3 [D9] m4)", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: Runtime[] = [];

  const createRuntimeWithConversation = (
    sessionId: string,
  ): { runtime: Runtime; workspaceCwd: string } => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-rename-conversation-test-"));
    temporaryDirectories.push(workspaceCwd);
    writeTranscriptFixture(workspaceCwd, sessionId);
    const runtime = createTerminalRuntime({ workspaceCwd, gitClient: noopGitClient() });
    runtimes.push(runtime);
    return { runtime, workspaceCwd };
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

  it("persists a title over the transcript store and surfaces it on the native read", () => {
    const { runtime } = createRuntimeWithConversation("terminal-1");

    // Before rename the conversation shows the auto-derived title from its first user turn
    // (#45 Phase 3 [D9] auto-title fold) — a stored rename must override it.
    expect(runtime.readConversationSession("terminal-1")?.title).toBe("draft the launch note");

    const result = runtime.renameConversation("terminal-1", "  Launch planning  ");
    expect(result.status).toBe("renamed");
    if (result.status === "renamed") {
      expect(result.title).toBe("Launch planning");
    }

    // The stored title is surfaced by the already-native GET read + the list summary.
    expect(runtime.readConversationSession("terminal-1")?.title).toBe("Launch planning");
    const listed = runtime.listConversationSessions().find((c) => c.sessionId === "terminal-1");
    expect(listed?.title).toBe("Launch planning");
  });

  it("overwrites an existing title on a second rename", () => {
    const { runtime } = createRuntimeWithConversation("terminal-1");
    runtime.renameConversation("terminal-1", "First");
    runtime.renameConversation("terminal-1", "Second");
    expect(runtime.readConversationSession("terminal-1")?.title).toBe("Second");
  });

  it("rejects a blank title (legacy required-field 400) and pins nothing", () => {
    const { runtime } = createRuntimeWithConversation("terminal-1");
    const result = runtime.renameConversation("terminal-1", "   ");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.error).toBe("title is required");
    }
    // No stored title was pinned — the read still falls back to the auto-derived title.
    expect(runtime.readConversationSession("terminal-1")?.title).toBe("draft the launch note");
  });

  it("returns no-conversation when neither a terminal record nor a transcript exists (legacy 404)", () => {
    const { runtime } = createRuntimeWithConversation("terminal-1");
    expect(runtime.renameConversation("terminal-does-not-exist", "x").status).toBe(
      "no-conversation",
    );
  });
});
