import { p33TurnStartedSince, p33VisibleAtPrompt } from "../src/terminalRuntime/logTruth";
import { createChannelMessaging } from "../src/terminalRuntime/channelMessaging";
import { mkdirSync as p33mk, writeFileSync as p33wf, appendFileSync as p33af } from "node:fs";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

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
  readConversationSession,
  transcriptFilenameForSession,
} from "../src/terminalRuntime/conversations";
import type { ProcessIdentity } from "../src/terminalRuntime/providerPresence";
import { buildClaudeResumeCommand, createSessionRuntime } from "../src/terminalRuntime/sessionRuntime";
import type { PersistedTerminal, TerminalSession } from "../src/terminalRuntime/types";

class FakePty extends EventEmitter {
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
  readonly registeredDataListeners: Array<(chunk: string) => void> = [];
  readonly registeredExitListeners: Array<(event: { exitCode: number; signal: number }) => void> =
    [];

  onData(listener: (chunk: string) => void) {
    this.registeredDataListeners.push(listener);
    this.on("data", listener);
    return {
      dispose: () => {
        this.off("data", listener);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal: number }) => void) {
    this.registeredExitListeners.push(listener);
    this.on("exit", listener);
    return {
      dispose: () => {
        this.off("exit", listener);
      },
    };
  }

  emitData(chunk: string) {
    this.emit("data", chunk);
  }

  emitExit(exitCode: number, signal: number) {
    this.emit("exit", { exitCode, signal });
  }

  invokeRegisteredData(chunk: string) {
    for (const listener of this.registeredDataListeners) {
      listener(chunk);
    }
  }

  invokeRegisteredExit(exitCode: number, signal: number) {
    for (const listener of this.registeredExitListeners) {
      listener({ exitCode, signal });
    }
  }
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sentMessages: string[] = [];
  send = vi.fn((payload: string) => {
    this.sentMessages.push(payload);
  });
  close = vi.fn(() => {
    if (this.readyState !== 1) {
      return;
    }

    this.readyState = 3;
    this.emit("close");
  });
}

class FakeWebSocketServer {
  nextSocket: FakeWebSocket | null = null;

  handleUpgrade = vi.fn(
    (
      _request: IncomingMessage,
      _socket: Duplex,
      _head: Buffer,
      callback: (socket: FakeWebSocket) => void,
    ) => {
      if (!this.nextSocket) {
        throw new Error("Missing websocket for upgrade.");
      }

      const socket = this.nextSocket;
      this.nextSocket = null;
      callback(socket);
    },
  );
}

const createUpgradeRequest = (tentacleId: string) =>
  ({
    url: `/api/terminals/${tentacleId}/ws`,
  }) as IncomingMessage;

const parseSentMessages = (socket: FakeWebSocket) =>
  socket.sentMessages.map((raw) => JSON.parse(raw) as { type: string; data?: string });

describe("P33 enter retry", () => {
  const temporaryDirectories: string[] = [];

  const createTemporaryDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "octogent-session-runtime-test-"));
    temporaryDirectories.push(directory);
    return directory;
  };

  beforeEach(() => {
    createShellEnvironmentMock.mockClear();
    ensureSpawnHelperMock.mockClear();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  const startDetectedCodexSession = (readProcessIdentities?: () => Promise<ProcessIdentity[]>, codexTurnWatchdogMs = 0) => {
    const tentacleId = "tentacle-detected-codex";
    const terminals = new Map<string, PersistedTerminal>([
      [
        tentacleId,
        {
          terminalId: tentacleId,
          tentacleId,
          tentacleName: tentacleId,
          createdAt: new Date().toISOString(),
          workspaceMode: "shared",
          agentProvider: "codex",
        },
      ],
    ]);
    const sessions = new Map<string, TerminalSession>();
    const pty = new FakePty();
    if (readProcessIdentities) Object.defineProperty(pty, "pid", { value: 123 });
    const onAgentProviderChange = vi.fn();
    const onHeldActivityChange = vi.fn();
    spawnMock.mockReturnValue(pty);
    const websocketServer = new FakeWebSocketServer();
    const runtime = createSessionRuntime({
      websocketServer: websocketServer as unknown as import("ws").WebSocketServer,
      terminals,
      sessions,
      getTentacleWorkspaceCwd: () => process.cwd(),
      isDebugPtyLogsEnabled: false,
      ptyLogDir: process.cwd(),
      transcriptDirectoryPath: createTemporaryDirectory(),
      onAgentProviderChange,
      onHeldActivityChange,
      codexTurnWatchdogMs,
      ...(readProcessIdentities ? { readProcessIdentities } : {}),
    });
    if (readProcessIdentities) {
      expect(runtime.startShellSession(tentacleId)).toBe(true);
    } else {
      expect(runtime.startSession(tentacleId)).toBe(true);
      expect(runtime.setDetectedAgentProvider(tentacleId, "codex")).toBe(true);
    }
    const session = sessions.get(tentacleId);
    if (!session) throw new Error("expected live session");
    onAgentProviderChange.mockClear();
    return { onHeldActivityChange, onAgentProviderChange, pty, runtime, session, tentacleId, websocketServer, terminals };
  };



  const BP_START = "\x1b[200~"; const BP_END = "\x1b[201~";
  const line = (type: string, ts: string) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type, turn_id: "t" } });
  const envKeys = ["OCTO_ENTER_RETRY", "OCTO_ENTER_RETRY_MS", "USERPROFILE", "HOME"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of envKeys) saved[k] = process.env[k]; });
  afterEach(() => { for (const k of envKeys) { if (saved[k] === undefined) Reflect.deleteProperty(process.env, k); else process.env[k] = saved[k]; } });

  const liveCodex = async (watchdogMs = 0) => {
    const createdAt = Date.now();
    const shell = { pid: 123, parentPid: 0, name: "cmd.exe", createdAt };
    const reader = vi.fn(async () => [shell]);
    const f = startDetectedCodexSession(reader, watchdogMs);
    expect(await f.runtime.prepareSessionLaunch(f.tentacleId)).toBe(true);
    expect(f.runtime.startSession(f.tentacleId)).toBe(true);
    reader.mockResolvedValue([shell, { pid: 124, parentPid: 123, name: "codex.exe", createdAt }]);
    await f.runtime.refreshProviderPresence();
    return f;
  };

  const ev = (type: string, ms: number) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type: "event_msg", payload: { type } });
  const setupHome = (kind: "codex" | "claude", id: string) => {
    const home = createTemporaryDirectory(); process.env.USERPROFILE = home; process.env.HOME = home;
    const dir = kind === "codex" ? join(home, ".codex", "sessions", "2026", "11", "03") : join(home, ".claude", "projects", "proj");
    p33mk(dir, { recursive: true });
    const file = join(dir, kind === "codex" ? `rollout-2026-11-03T08-00-00-${id}.jsonl` : `${id}.jsonl`);
    p33wf(file, (kind === "codex" ? ev("task_complete", Date.now() - 60_000) : JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() - 60_000).toISOString(), message: { stop_reason: "end_turn" } })) + "\n");
    return file;
  };
  const enterCount = (pty: any) => pty.write.mock.calls.filter(([t]: unknown[]) => t === "\r").length;
  const TEXT = "Read Claude Cowork/handoffs/2026-11-03-vaultagent-DISPATCH-native-abi-proposal-0905.md";

  it("P33 retry fires once when no start appears and text is still at the prompt, then blocks", async () => {
    vi.useFakeTimers(); process.env.OCTO_ENTER_RETRY = "1"; process.env.OCTO_ENTER_RETRY_MS = "1000";
    const id = "01a1aaaa-0000-7000-8000-000000000001"; setupHome("codex", id);
    const f = await liveCodex(); f.terminals.get(f.tentacleId)!.codexThreadId = id;
    try {
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}${TEXT}${BP_END}\r`)).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
      f.pty.emitData(`> [Channel message from VaultAgent]: ${TEXT.replace(/ /g, "")}`);
      expect(enterCount(f.pty)).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(enterCount(f.pty)).toBe(2); // exactly one extra Enter, never retyped
      expect(f.pty.write.mock.calls.filter(([t]: unknown[]) => String(t).includes("abi-proposal")).length).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)?.reason).toBe("dirty_input_needs_clean");
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}next${BP_END}\r`)).toBe(false);
    } finally { f.runtime.close(); }
  });

  it("P33 no retry when the rollout shows a start after the delivery", async () => {
    vi.useFakeTimers(); process.env.OCTO_ENTER_RETRY = "1"; process.env.OCTO_ENTER_RETRY_MS = "1000";
    const id = "01a1aaaa-0000-7000-8000-000000000002"; const file = setupHome("codex", id);
    const f = await liveCodex(); f.terminals.get(f.tentacleId)!.codexThreadId = id;
    try {
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}${TEXT}${BP_END}\r`)).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
      f.pty.emitData(TEXT);
      p33af(file, ev("task_started", Date.now()) + "\n");
      await vi.advanceTimersByTimeAsync(3000);
      expect(enterCount(f.pty)).toBe(1);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)).toBeUndefined();
    } finally { f.runtime.close(); }
  });

  it("P33 a start after the retry clears it without blocking", async () => {
    vi.useFakeTimers(); process.env.OCTO_ENTER_RETRY = "1"; process.env.OCTO_ENTER_RETRY_MS = "1000";
    const id = "01a1aaaa-0000-7000-8000-000000000003"; const file = setupHome("codex", id);
    const f = await liveCodex(); f.terminals.get(f.tentacleId)!.codexThreadId = id;
    try {
      f.runtime.writeInput(f.tentacleId, `${BP_START}${TEXT}${BP_END}\r`);
      await vi.advanceTimersByTimeAsync(400); f.pty.emitData(TEXT);
      await vi.advanceTimersByTimeAsync(1000); expect(enterCount(f.pty)).toBe(2);
      p33af(file, ev("user_message", Date.now()) + "\n");
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)).toBeUndefined();
    } finally { f.runtime.close(); }
  });

  it("P33 flag off: no retry", async () => {
    vi.useFakeTimers(); Reflect.deleteProperty(process.env, "OCTO_ENTER_RETRY"); process.env.OCTO_ENTER_RETRY_MS = "1000";
    const id = "01a1aaaa-0000-7000-8000-000000000004"; setupHome("codex", id);
    const f = await liveCodex(); f.terminals.get(f.tentacleId)!.codexThreadId = id;
    try {
      f.runtime.writeInput(f.tentacleId, `${BP_START}${TEXT}${BP_END}\r`);
      await vi.advanceTimersByTimeAsync(400); f.pty.emitData(TEXT);
      await vi.advanceTimersByTimeAsync(3000);
      expect(enterCount(f.pty)).toBe(1);
    } finally { f.runtime.close(); }
  });

  it("P33 Claude path: retry fires when the transcript has no new user/assistant entry", async () => {
    vi.useFakeTimers(); process.env.OCTO_ENTER_RETRY = "1"; process.env.OCTO_ENTER_RETRY_MS = "5000";
    const sid = "d6ed3a98-0000-4000-8000-00000000c1a0"; const file = setupHome("claude", sid);
    const createdAt = Date.now();
    const reader = vi.fn(async () => [{ pid: 123, parentPid: 0, name: "cmd.exe", createdAt }, { pid: 124, parentPid: 123, name: "claude.exe", createdAt }]);
    const f = startDetectedCodexSession(reader);
    f.terminals.get(f.tentacleId)!.claudeSessionId = sid;
    try {
      await f.runtime.refreshProviderPresence();
      expect(f.runtime.getEffectiveAgentProvider(f.tentacleId)).toBe("claude-code");
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}${TEXT}${BP_END}\r`)).toBe(true);
      await vi.advanceTimersByTimeAsync(400); f.pty.emitData(TEXT);
      await vi.advanceTimersByTimeAsync(3000);
      const before = enterCount(f.pty); // Claude gets its built-in Enters at 0.2/1/3 s first
      await vi.advanceTimersByTimeAsync(5000);
      expect(enterCount(f.pty)).toBe(before + 1);
      p33af(file, JSON.stringify({ type: "user", timestamp: new Date(Date.now()).toISOString(), message: { content: TEXT } }) + "\n");
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)).toBeUndefined();
    } finally { f.runtime.close(); }
  });

  it("P33 pure helpers", () => {
    const t0 = Date.parse("2026-11-03T08:24:47Z");
    expect(p33TurnStartedSince("codex", [ev("task_complete", t0 - 60_000), JSON.stringify({ timestamp: new Date(t0 + 1000).toISOString(), type: "response_item" })].join("\n"), t0)).toBe(false);
    expect(p33TurnStartedSince("codex", ev("task_started", t0 + 5000), t0)).toBe(true);
    expect(p33TurnStartedSince("claude", JSON.stringify({ type: "assistant", timestamp: new Date(t0 + 3000).toISOString(), message: {} }), t0)).toBe(true);
    expect(p33TurnStartedSince("claude", null, t0)).toBeNull();
    expect(p33VisibleAtPrompt("> [ChannelmessagefromVaultAgent]:ReadClaudeCowork/handoffs/x.md", "[Channel message from VaultAgent]: Read Claude Cowork/handoffs/x.md")).toBe(true);
    expect(p33VisibleAtPrompt("> ", "some delivered text here")).toBe(false);
    expect(p33VisibleAtPrompt('<octogent-turn id="octogent-turn-1-abc" />', "x", "octogent-turn-1-abc")).toBe(true);
  });

  it("P33 notSubmitted is persisted on the message and visible in the list (delivered stays true)", () => {
    const sessions = new Map<string, TerminalSession>([["t1", { agentState: "idle" } as unknown as TerminalSession]]);
    const terminals = new Map<string, PersistedTerminal>([["t1", { terminalId: "t1", tentacleId: "t1", tentacleName: "CTO", createdAt: "", workspaceMode: "shared" } as PersistedTerminal]]);
    const dir = createTemporaryDirectory();
    const cm = createChannelMessaging({ terminals, sessions, writeInput: () => true, persistence: { queuePath: join(dir, "q.jsonl"), deadLetterPath: join(dir, "d.jsonl") } });
    const m = cm.sendChannelMessage("t1", "t2", "hello", { immediateOnly: true })!;
    expect(m.delivered).toBe(true); expect(m.deliveredAt).toBeTruthy();
    expect(cm.markNotSubmitted("t1", "dirty_input_needs_clean", "2026-11-03T09:00:00Z", m.deliveredAt)).toEqual([m.messageId]);
    const listed = cm.listChannelMessages("t1").find((x) => x.messageId === m.messageId)!;
    expect(listed).toMatchObject({ delivered: true, notSubmitted: true, notSubmittedReason: "dirty_input_needs_clean", notSubmittedAt: "2026-11-03T09:00:00Z" });
    const reloaded = createChannelMessaging({ terminals, sessions, writeInput: () => true, persistence: { queuePath: join(dir, "q.jsonl"), deadLetterPath: join(dir, "d.jsonl") } });
    expect(reloaded.listChannelMessages("t1").find((x) => x.messageId === m.messageId)?.notSubmitted).toBe(true);
  });
});