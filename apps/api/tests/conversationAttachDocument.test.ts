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

import { buildAttachmentDeliveryTurn, buildConversationInputSubmit } from "@octogent/core";

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

// The exact bracketed-paste + CR PTY payload the runtime submits to DELIVER an attachment reference
// into the live session — reconstructed from the same pure core contract the runtime uses.
const expectedDeliveryPayload = (filename: string, absolutePath: string): string =>
  buildConversationInputSubmit(buildAttachmentDeliveryTurn(filename, absolutePath)).submitPayload;

describe("attach-document adapter — runtime.attachDocumentToConversation (#45 Phase 3 [D9] m8)", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: Runtime[] = [];

  // A runtime with a LIVE, idle Claude Code session bound to a chat conversation. The mocked PTY is
  // returned to the caller so a test can assert what the runtime submits into the live agent.
  const startLiveConversation = (): {
    runtime: Runtime;
    pty: FakePty;
    workspaceCwd: string;
    sessionId: string;
  } => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-attach-document-test-"));
    temporaryDirectories.push(workspaceCwd);
    const pty = new FakePty();
    spawnMock.mockReturnValue(pty);

    const runtime = createTerminalRuntime({ workspaceCwd, gitClient: noopGitClient() });
    runtimes.push(runtime);
    const created = runtime.createConversation({ initialPrompt: "You are the CEO tentacle." });
    if (created.status !== "created") {
      throw new Error("failed to create conversation");
    }
    return { runtime, pty, workspaceCwd, sessionId: created.sessionId };
  };

  // The managed per-conversation document store path — under the project STATE dir, keyed by the
  // conversation identity (NOT the tentacle workspace / repo root).
  const storePath = (workspaceCwd: string, sessionId: string, filename: string) =>
    join(workspaceCwd, ".octogent", "state", "documents", encodeURIComponent(sessionId), filename);

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

  it("proves the full loop: attach → per-conversation store → live session receives the reference turn → the path resolves", () => {
    const { runtime, pty, workspaceCwd, sessionId } = startLiveConversation();

    const content = "# Launch plan\n\nShip it.";
    const result = runtime.attachDocumentToConversation(sessionId, {
      filename: "launch-notes.md",
      content,
    });

    expect(result.status).toBe("attached");
    if (result.status !== "attached") {
      throw new Error("expected attached");
    }
    // (1) stored in the per-conversation document store (managed, keyed, under the state dir).
    const expectedAbsolute = storePath(workspaceCwd, sessionId, "launch-notes.md");
    expect(result.absolutePath).toBe(expectedAbsolute);
    expect(result.path).toBe(
      join(".octogent", "state", "documents", encodeURIComponent(sessionId), "launch-notes.md"),
    );
    expect(existsSync(result.absolutePath)).toBe(true);

    // (2) the live session RECEIVED the reference turn — the exact proven send-message PTY payload,
    // referencing the stored absolute path so the tentacle (which IS Claude Code, [D8]) Reads it.
    expect(result.delivery).toBe("delivered");
    expect(pty.write).toHaveBeenCalledWith(
      expectedDeliveryPayload("launch-notes.md", result.absolutePath),
    );

    // (3) the (simulated) agent resolves the path it was handed and gets the document content back.
    const deliveredWrite = pty.write.mock.calls
      .map((call) => call[0] as string)
      .find((data) => data.includes(result.absolutePath));
    expect(deliveredWrite).toBeDefined();
    const pathTheAgentSees = result.absolutePath;
    expect(deliveredWrite).toContain(pathTheAgentSees);
    expect(readFileSync(pathTheAgentSees, "utf8")).toBe(content);
  });

  it("keys the store by conversation identity and keeps a traversal filename inside it (path-traversal-safe)", () => {
    const { runtime, workspaceCwd, sessionId } = startLiveConversation();

    const result = runtime.attachDocumentToConversation(sessionId, {
      filename: "../../etc/passwd",
      content: "root:x:0:0",
    });

    expect(result.status).toBe("attached");
    if (result.status !== "attached") {
      throw new Error("expected attached");
    }
    expect(result.filename).toBe("passwd");
    // Lands inside THIS conversation's store dir, not at an escaped path.
    expect(result.absolutePath).toBe(storePath(workspaceCwd, sessionId, "passwd"));
    expect(result.absolutePath).toContain(encodeURIComponent(sessionId));
    expect(existsSync(storePath(workspaceCwd, sessionId, "passwd"))).toBe(true);
  });

  it("enumerates the conversation's document store (survives across turns, listable)", () => {
    const { runtime, sessionId } = startLiveConversation();

    expect(runtime.listConversationDocuments(sessionId)).toEqual([]);
    runtime.attachDocumentToConversation(sessionId, { filename: "b-notes.md", content: "b" });
    runtime.attachDocumentToConversation(sessionId, { filename: "a-notes.md", content: "a" });

    // Both survive and are enumerable (sorted).
    expect(runtime.listConversationDocuments(sessionId)).toEqual(["a-notes.md", "b-notes.md"]);
  });

  it("defers delivery when the session is busy, then delivers on the next idle hook (deliver-on-next-ready)", () => {
    const { runtime, pty, workspaceCwd, sessionId } = startLiveConversation();

    // Put the session under the processing lock (a chat turn in flight).
    expect(runtime.submitConversationMessage(sessionId, "do some work").status).toBe("accepted");

    const result = runtime.attachDocumentToConversation(sessionId, {
      filename: "context.md",
      content: "reference me later",
    });
    expect(result.status).toBe("attached");
    if (result.status !== "attached") {
      throw new Error("expected attached");
    }
    // Stored immediately, but NOT delivered while the agent is mid-turn.
    expect(result.delivery).toBe("deferred");
    expect(existsSync(storePath(workspaceCwd, sessionId, "context.md"))).toBe(true);
    const deliveryPayload = expectedDeliveryPayload("context.md", result.absolutePath);
    expect(pty.write).not.toHaveBeenCalledWith(deliveryPayload);

    // The agent goes idle → the idle hook flushes the pending reference into the live session.
    runtime.handleHook("notification", { notification_type: "idle_prompt" }, sessionId);
    expect(pty.write).toHaveBeenCalledWith(deliveryPayload);
  });

  it("rejects an invalid attachment (missing content / bad filename / binary type) with legacy-shape errors", () => {
    const { runtime, sessionId } = startLiveConversation();

    const noContent = runtime.attachDocumentToConversation(sessionId, { filename: "notes.md" });
    expect(noContent.status).toBe("invalid");
    if (noContent.status === "invalid") {
      expect(noContent.error).toBe("content is required");
    }

    expect(
      runtime.attachDocumentToConversation(sessionId, { filename: "..", content: "x" }).status,
    ).toBe("invalid");

    const binary = runtime.attachDocumentToConversation(sessionId, {
      filename: "photo.png",
      content: "x",
    });
    expect(binary.status).toBe("invalid");
    if (binary.status === "invalid") {
      expect(binary.error).toBe("unsupported file type");
    }
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
