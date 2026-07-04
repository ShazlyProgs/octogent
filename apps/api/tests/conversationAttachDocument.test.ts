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

vi.mock("node-pty", () => ({ spawn: spawnMock }));

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

describe("attach-document adapter — runtime.attachDocumentToConversation (#45 Phase 3 [D9] m7)", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: Runtime[] = [];

  const startLiveConversation = (): {
    runtime: Runtime;
    workspaceCwd: string;
    sessionId: string;
  } => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-attach-document-test-"));
    temporaryDirectories.push(workspaceCwd);
    spawnMock.mockReturnValue(new FakePty());

    const runtime = createTerminalRuntime({ workspaceCwd, gitClient: noopGitClient() });
    runtimes.push(runtime);
    const created = runtime.createConversation({ initialPrompt: "You are the CEO tentacle." });
    if (created.status !== "created") {
      throw new Error("failed to create conversation");
    }
    return { runtime, workspaceCwd, sessionId: created.sessionId };
  };

  const attachmentsPath = (workspaceCwd: string, sessionId: string, filename: string) =>
    join(workspaceCwd, ".octogent", "attachments", encodeURIComponent(sessionId), filename);

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

  it("writes the uploaded document into the tentacle's workspace attachments dir", () => {
    const { runtime, workspaceCwd, sessionId } = startLiveConversation();

    const result = runtime.attachDocumentToConversation(sessionId, {
      filename: "launch-notes.md",
      content: "# Launch plan\n\nShip it.",
    });

    expect(result.status).toBe("attached");
    if (result.status !== "attached") {
      throw new Error("expected attached");
    }
    expect(result.filename).toBe("launch-notes.md");

    const onDisk = attachmentsPath(workspaceCwd, sessionId, "launch-notes.md");
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, "utf8")).toBe("# Launch plan\n\nShip it.");
  });

  it("sanitizes a traversal filename to a basename that stays inside the attachments dir", () => {
    const { runtime, workspaceCwd, sessionId } = startLiveConversation();

    const result = runtime.attachDocumentToConversation(sessionId, {
      filename: "../../etc/passwd",
      content: "root:x:0:0",
    });

    expect(result.status).toBe("attached");
    if (result.status === "attached") {
      expect(result.filename).toBe("passwd");
    }
    // The file lands inside the conversation's attachments dir, not at an escaped path.
    expect(existsSync(attachmentsPath(workspaceCwd, sessionId, "passwd"))).toBe(true);
  });

  it("surfaces the attachment in the conversation transcript (best-effort link)", async () => {
    const { runtime, workspaceCwd, sessionId } = startLiveConversation();

    runtime.attachDocumentToConversation(sessionId, { filename: "notes.md", content: "hi" });

    await runtime.close();
    runtimes.length = 0; // already closed — don't double-close in afterEach.

    const transcriptPath = join(
      workspaceCwd,
      ".octogent",
      "state",
      "transcripts",
      `${encodeURIComponent(sessionId)}.jsonl`,
    );
    for (let attempt = 0; attempt < 20 && !existsSync(transcriptPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = readFileSync(transcriptPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; text?: string });
    const attachEvent = events.find(
      (event) => event.type === "input_submit" && event.text === "[Attached document: notes.md]",
    );
    expect(attachEvent).toBeDefined();
  });

  it("rejects an invalid attachment (missing content / bad filename) with legacy-shape errors", () => {
    const { runtime, sessionId } = startLiveConversation();

    const noContent = runtime.attachDocumentToConversation(sessionId, { filename: "notes.md" });
    expect(noContent.status).toBe("invalid");
    if (noContent.status === "invalid") {
      expect(noContent.error).toBe("content is required");
    }

    const badName = runtime.attachDocumentToConversation(sessionId, {
      filename: "..",
      content: "x",
    });
    expect(badName.status).toBe("invalid");
  });

  it("returns no-conversation for an unknown session (legacy 404)", () => {
    const { runtime } = startLiveConversation();
    expect(
      runtime.attachDocumentToConversation("terminal-does-not-exist", {
        filename: "notes.md",
        content: "x",
      }).status,
    ).toBe("no-conversation");
  });
});
