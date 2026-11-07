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

describe("P33b typed enter retry", () => {
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
  const envKeys = ["OCTO_ENTER_RETRY", "OCTO_ENTER_RETRY_MS", "OCTO_ENTER_RETRY_TYPED", "USERPROFILE", "HOME"] as const;
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

  const typedSetup = async (n: string) => {
    vi.useFakeTimers(); process.env.OCTO_ENTER_RETRY = "1"; process.env.OCTO_ENTER_RETRY_MS = "1000"; Reflect.deleteProperty(process.env, "OCTO_ENTER_RETRY_TYPED");
    const id = `01a1bbbb-0000-7000-8000-00000000000${n}`; const file = setupHome("codex", id);
    const f = await liveCodex(); f.terminals.get(f.tentacleId)!.codexThreadId = id;
    return { f, file };
  };
  const INJ = "[GROK WATCH] VaultAgent: event 1012 fired, read ops/event-1012/NOTE.md and act";

  it("P33b typed burst + Enter with no start gets ONE retry, then blocks (journal source=typed)", async () => {
    const { f } = await typedSetup("1");
    try {
      f.runtime.observeTypedInput(f.tentacleId, INJ.slice(0, 30));
      f.runtime.observeTypedInput(f.tentacleId, INJ.slice(30));
      f.runtime.observeTypedInput(f.tentacleId, "\r");
      f.pty.emitData(`> ${INJ}`);
      await vi.advanceTimersByTimeAsync(1000);
      expect(enterCount(f.pty)).toBe(1);
      expect(f.pty.write.mock.calls.filter(([t]: unknown[]) => String(t).includes("GROK WATCH")).length).toBe(0); // never retyped
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)?.reason).toBe("dirty_input_needs_clean");
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}next${BP_END}\r`)).toBe(false);
    } finally { f.runtime.close(); }
  });

  it("P33b typed + Enter with a start in the log gets nothing", async () => {
    const { f, file } = await typedSetup("2");
    try {
      f.runtime.observeTypedInput(f.tentacleId, INJ + "\r");
      f.pty.emitData(INJ);
      p33af(file, ev("task_started", Date.now()) + "\n");
      await vi.advanceTimersByTimeAsync(3000);
      expect(enterCount(f.pty)).toBe(0);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)).toBeUndefined();
    } finally { f.runtime.close(); }
  });

  it("P33b short human keystrokes and text without Enter get nothing", async () => {
    const { f } = await typedSetup("3");
    try {
      f.runtime.observeTypedInput(f.tentacleId, "yes"); f.runtime.observeTypedInput(f.tentacleId, "\r");
      f.pty.emitData("yes");
      for (const ch of "a long draft the human is still typing") f.runtime.observeTypedInput(f.tentacleId, ch);
      f.pty.emitData("a long draft the human is still typing");
      await vi.advanceTimersByTimeAsync(3000);
      expect(enterCount(f.pty)).toBe(0);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)).toBeUndefined();
    } finally { f.runtime.close(); }
  });

  it("P33b text no longer visible at the prompt: no retry, no block", async () => {
    const { f } = await typedSetup("4");
    try {
      f.runtime.observeTypedInput(f.tentacleId, INJ + "\r");
      f.pty.emitData("> ");
      await vi.advanceTimersByTimeAsync(3000);
      expect(enterCount(f.pty)).toBe(0);
      expect(f.runtime.getDeliveryBlocked(f.tentacleId)).toBeUndefined();
    } finally { f.runtime.close(); }
  });

  it("P33b OCTO_ENTER_RETRY_TYPED=0 disables the typed path", async () => {
    const { f } = await typedSetup("5"); process.env.OCTO_ENTER_RETRY_TYPED = "0";
    try {
      f.runtime.observeTypedInput(f.tentacleId, INJ + "\r"); f.pty.emitData(INJ);
      await vi.advanceTimersByTimeAsync(3000);
      expect(enterCount(f.pty)).toBe(0);
    } finally { f.runtime.close(); }
  });

  it("P33b pure step: backspace, escapes, burst", async () => {
    const { p33bTypedStep } = await import("../src/terminalRuntime/logTruth");
    expect(p33bTypedStep("", "abc\x7fd")).toEqual({ buf: "abd" });
    expect(p33bTypedStep("ab", "\x1b[200~cd\x1b[201~\r")).toEqual({ buf: "", submit: "abcd" });
  });
});
