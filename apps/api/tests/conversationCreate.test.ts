import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createShellEnvironmentMock, ensureSpawnHelperMock, spawnMock } = vi.hoisted(() => ({
  createShellEnvironmentMock: vi.fn(() => ({})),
  ensureSpawnHelperMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("node-pty", () => ({
  spawn: spawnMock,
}));

vi.mock("../src/terminalRuntime/ptyEnvironment", () => ({
  createShellEnvironment: createShellEnvironmentMock,
  ensureNodePtySpawnHelperExecutable: ensureSpawnHelperMock,
}));

import { createTerminalRuntime } from "../src/terminalRuntime";
import type { GitClient } from "../src/terminalRuntime";

class FakePty extends EventEmitter {
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();

  onData(listener: (chunk: string) => void) {
    this.on("data", listener);
    return { dispose: () => this.off("data", listener) };
  }

  onExit(listener: (event: { exitCode: number; signal: number }) => void) {
    this.on("exit", listener);
    return { dispose: () => this.off("exit", listener) };
  }
}

const noopGitClient = (): GitClient =>
  ({
    assertAvailable() {},
    isRepository: () => true,
  }) as unknown as GitClient;

type Runtime = ReturnType<typeof createTerminalRuntime>;

describe("create-conversation adapter — runtime.createConversation (#45 Phase 3 [D9] m3)", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: Runtime[] = [];

  const createRuntime = (): { runtime: Runtime; pty: FakePty } => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-create-conversation-test-"));
    temporaryDirectories.push(workspaceCwd);
    const pty = new FakePty();
    spawnMock.mockReturnValue(pty);

    const runtime = createTerminalRuntime({ workspaceCwd, gitClient: noopGitClient() });
    runtimes.push(runtime);
    return { runtime, pty };
  };

  beforeEach(() => {
    createShellEnvironmentMock.mockClear();
    ensureSpawnHelperMock.mockClear();
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

  it("starts a LIVE chat session bound to a tentacle terminal and returns its identity", () => {
    const { runtime, pty } = createRuntime();

    const result = runtime.createConversation({
      initialPrompt: "You are the CEO tentacle.",
      title: "Launch planning",
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("expected created");
    }
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.tentacleName).toBe("Launch planning");
    expect(result.workspaceMode).toBe("shared");
    // A live PTY-backed Claude Code session was spawned (initialPrompt drives startSession).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(pty).toBeDefined();

    // End-to-end proof of parity: the created conversation is functional — it can receive a chat
    // turn via the keystone send-message path (which requires a LIVE session). A conversation
    // that merely existed in the registry (no live session) would return "no-session" here.
    const send = runtime.submitConversationMessage(result.sessionId, "kick off the plan");
    expect(send.status).toBe("accepted");

    // The session is visible as a live terminal snapshot with a runtime state.
    const snapshot = runtime
      .listTerminalSnapshots()
      .find((entry) => entry.terminalId === result.sessionId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.agentRuntimeState).toBeDefined();
  });

  it("auto-names the session when no title is supplied", () => {
    const { runtime } = createRuntime();

    const result = runtime.createConversation({ initialPrompt: "seed" });
    expect(result.status).toBe("created");
    if (result.status === "created") {
      // createTerminal's generated default name (e.g. "Octogent Terminal 1").
      expect(result.tentacleName.length).toBeGreaterThan(0);
    }
  });

  it("rejects a create with no initialPrompt (legacy 400 'agent_id is required' analog)", () => {
    const { runtime } = createRuntime();

    const missing = runtime.createConversation({});
    expect(missing.status).toBe("invalid");
    if (missing.status === "invalid") {
      expect(missing.error).toBe("initialPrompt is required");
    }
    // Nothing was spawned for the rejected create.
    expect(spawnMock).not.toHaveBeenCalled();

    const blank = runtime.createConversation({ initialPrompt: "   " });
    expect(blank.status).toBe("invalid");
  });
});
