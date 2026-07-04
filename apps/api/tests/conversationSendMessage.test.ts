import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

import {
  SEND_MESSAGE_BRACKETED_PASTE_END,
  SEND_MESSAGE_BRACKETED_PASTE_START,
} from "@octogent/core";

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

// Shared-mode terminals never touch worktree git ops, so a no-op client is sufficient here.
const noopGitClient = (): GitClient =>
  ({
    assertAvailable() {},
    isRepository: () => true,
  }) as unknown as GitClient;

type Runtime = ReturnType<typeof createTerminalRuntime>;

describe("send-message adapter — runtime.submitConversationMessage (#45 Phase 3 [D9] keystone)", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: Runtime[] = [];

  const createWorkspace = () => {
    const directory = mkdtempSync(join(tmpdir(), "octogent-send-message-test-"));
    temporaryDirectories.push(directory);
    return directory;
  };

  // Create a runtime with a LIVE, idle Claude Code session bound to terminal-1. The session is
  // spawned by createTerminal({ initialPrompt }) → startSession → the mocked PTY. Bootstrap writes
  // "claude\r" directly (not through the submit path), so the session starts idle/ready.
  const startLiveSession = (): { runtime: Runtime; pty: FakePty; workspaceCwd: string } => {
    const workspaceCwd = createWorkspace();
    const pty = new FakePty();
    spawnMock.mockReturnValue(pty);

    const runtime = createTerminalRuntime({ workspaceCwd, gitClient: noopGitClient() });
    runtimes.push(runtime);
    runtime.createTerminal({
      terminalId: "terminal-1",
      workspaceMode: "shared",
      initialPrompt: "You are the CEO tentacle.",
    });
    return { runtime, pty, workspaceCwd };
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

  it("submits a chat turn into the live tentacle session as a bracketed-paste + CR PTY write", () => {
    const { runtime, pty } = startLiveSession();

    const result = runtime.submitConversationMessage("terminal-1", "  Draft the launch note  ");

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.tentacleId).toBe("terminal-1");
      expect(result.submitId).toBe("terminal-1:msg:1");
      expect(result.text).toBe("Draft the launch note");
    }
    // The turn reaches the REAL session input primitive as the atomic-paste + CR submit —
    // the same shape channel messaging uses, so Claude Code receives + runs it.
    expect(pty.write).toHaveBeenCalledWith(
      `${SEND_MESSAGE_BRACKETED_PASTE_START}Draft the launch note${SEND_MESSAGE_BRACKETED_PASTE_END}\r`,
    );
  });

  it("holds the per-conversation processing lock — a concurrent send returns busy (legacy 409)", () => {
    const { runtime } = startLiveSession();

    // First turn is accepted and flips the session to "processing" (arming the B.14 lock).
    expect(runtime.submitConversationMessage("terminal-1", "first").status).toBe("accepted");
    // A second send while the turn is still processing is rejected — no interleaved turns.
    const second = runtime.submitConversationMessage("terminal-1", "second");
    expect(second.status).toBe("busy");
    if (second.status === "busy") {
      expect(second.tentacleId).toBe("terminal-1");
    }
  });

  it("returns no-session when there is no live tentacle session to receive the turn (legacy 404)", () => {
    const { runtime } = startLiveSession();

    expect(runtime.submitConversationMessage("terminal-does-not-exist", "hello").status).toBe(
      "no-session",
    );
  });

  it("rejects empty / whitespace-only content on a ready session (legacy 400 'content is required')", () => {
    const { runtime, pty } = startLiveSession();
    const writeCallsBefore = pty.write.mock.calls.length;

    const empty = runtime.submitConversationMessage("terminal-1", "   \n  ");
    expect(empty.status).toBe("invalid-content");
    if (empty.status === "invalid-content") {
      expect(empty.error).toBe("content is required");
    }
    const missing = runtime.submitConversationMessage("terminal-1", undefined);
    expect(missing.status).toBe("invalid-content");

    // Nothing was submitted to the PTY for the rejected turns.
    expect(pty.write.mock.calls.length).toBe(writeCallsBefore);
  });

  it("records the accepted turn as an input_submit transcript event the native read surfaces", async () => {
    const { runtime, workspaceCwd } = startLiveSession();

    const result = runtime.submitConversationMessage("terminal-1", "surface me in the transcript");
    expect(result.status).toBe("accepted");

    // Close flushes the transcript stream; then read the on-disk JSONL like the native surface does.
    await runtime.close();
    runtimes.length = 0; // already closed — don't double-close in afterEach.

    const transcriptPath = join(
      workspaceCwd,
      ".octogent",
      "state",
      "transcripts",
      `${encodeURIComponent("terminal-1")}.jsonl`,
    );
    for (let attempt = 0; attempt < 20 && !existsSync(transcriptPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(transcriptPath)).toBe(true);

    const events = readFileSync(transcriptPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; text?: string; submitId?: string });

    const inputSubmit = events.find((event) => event.type === "input_submit");
    expect(inputSubmit).toBeDefined();
    expect(inputSubmit?.text).toBe("surface me in the transcript");
    expect(inputSubmit?.submitId).toBe("terminal-1:msg:1");
  });
});
