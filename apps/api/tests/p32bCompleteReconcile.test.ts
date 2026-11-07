import { mkdirSync } from "node:fs";
import { deriveCodexTruth, shouldReconcileLatch } from "../src/terminalRuntime/logTruth";
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

describe("P32b completed-unacknowledged reconcile", () => {
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
  const envKeys = ["OCTO_LATCH_RECONCILE", "OCTO_LATCH_RECONCILE_MS", "OCTO_POST_RESUME_RECONCILE", "OCTO_POST_RESUME_RECONCILE_MS", "OCTO_LATCH_COMPLETE_RECONCILE", "OCTO_LATCH_COMPLETE_RECONCILE_MS", "HOME", "USERPROFILE"] as const;
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

  let p34n = 0;
  const setup = async () => { vi.useFakeTimers(); process.env.OCTO_LATCH_RECONCILE = "1"; process.env.OCTO_POST_RESUME_RECONCILE = "1"; process.env.OCTO_POST_RESUME_RECONCILE_MS = "60000"; process.env.OCTO_LATCH_COMPLETE_RECONCILE = "1"; Reflect.deleteProperty(process.env, "OCTO_LATCH_COMPLETE_RECONCILE_MS");
    const home = mkdtempSync(join(tmpdir(), "p34-home-")); temporaryDirectories.push(home); process.env.USERPROFILE = home; process.env.HOME = home;
    const id = "01a1cccc-0000-7000-8000-00000000000" + String(++p34n); const dir = join(home, ".codex", "sessions", "2026", "11", "03"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-11-03T08-00-00-${id}.jsonl`), line("task_complete", new Date(Date.now() - 600_000).toISOString()) + "\n");
    const f = await liveCodex(); f.terminals.get(f.tentacleId)!.codexThreadId = id; f.session.stateTracker.forceState("processing"); f.session.agentState = "processing"; return f; };
  // the live latch is sticky (CoS 11:0x); the fake session has no PTY traffic, so pin it before each poll
  const rl = (f: any, truth: any, at?: number) => { f.session.agentState = "processing"; return f.runtime.reconcileLatch(f.tentacleId, truth, at); };
  const done = () => deriveCodexTruth(line("task_complete", new Date(Date.now() - 600_000).toISOString()));

  const deliver = async (f: any) => { f.session.stateTracker.forceState("idle"); f.session.agentState = "idle";
    expect(f.runtime.writeInput(f.tentacleId, `${BP_START}Read DISPATCH-cos-1316.md${BP_END}\r`)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000); };
  const after = () => deriveCodexTruth(line("task_complete", new Date(Date.now() - 1_000).toISOString()));

  it("P32b positive: completion newer than the delivery clears after 120 s", async () => {
    const f = await setup();
    try {
      await deliver(f); await vi.advanceTimersByTimeAsync(10_000);
      const tr = after(); const t0 = Date.now();
      expect(rl(f, tr, t0)).toBe(false);
      expect(rl(f, tr, t0 + 60_000)).toBe(false);
      expect(rl(f, tr, t0 + 119_000)).toBe(false);
      expect(rl(f, tr, t0 + 120_000)).toBe(true);
      expect(f.session.agentState).toBe("idle");
    } finally { f.runtime.close(); }
  });

  it("P32b negatives: open turn, newer start, unknown are never cleared", async () => {
    const f = await setup();
    try {
      await deliver(f); await vi.advanceTimersByTimeAsync(10_000);
      const now = new Date(Date.now() - 500).toISOString(); const t0 = Date.now();
      for (const [k, tr] of [["started", deriveCodexTruth(line("task_started", now))], ["user", deriveCodexTruth(line("user_message", now))], ["unknown", deriveCodexTruth(null)]] as const) {
        for (const dt of [0, 130_000, 300_000]) expect(rl(f, tr, t0 + dt), `${k}@${dt}`).toBe(false);
      }
      expect(f.session.agentState).toBe("processing");
    } finally { f.runtime.close(); }
  });

  it("P32b completion OLDER than the delivery is not P32b's case", async () => {
    const f = await setup();
    try {
      const old = deriveCodexTruth(line("task_complete", new Date(Date.now() - 600_000).toISOString()));
      await deliver(f); const t0 = Date.now();
      expect(rl(f, old, t0)).toBe(false); expect(rl(f, old, t0 + 130_000)).toBe(false); // P32 (3 min default) owns this
    } finally { f.runtime.close(); }
  });

  it("P32b timer resets when log-truth goes non-idle", async () => {
    const f = await setup();
    try {
      await deliver(f); await vi.advanceTimersByTimeAsync(10_000);
      const tr = after(); const t0 = Date.now();
      expect(rl(f, tr, t0)).toBe(false);
      expect(rl(f, tr, t0 + 100_000)).toBe(false);
      expect(rl(f, deriveCodexTruth(null), t0 + 110_000)).toBe(false); // reset
      expect(rl(f, tr, t0 + 125_000)).toBe(false); // clock restarts here
      expect(rl(f, tr, t0 + 240_000)).toBe(false);
      expect(rl(f, tr, t0 + 245_000)).toBe(true);
    } finally { f.runtime.close(); }
  });

  it("P32b flag off: no change", async () => {
    const f = await setup(); process.env.OCTO_LATCH_COMPLETE_RECONCILE = "0";
    try {
      await deliver(f); await vi.advanceTimersByTimeAsync(10_000);
      const tr = after(); const t0 = Date.now();
      for (const dt of [0, 130_000, 600_000]) expect(rl(f, tr, t0 + dt)).toBe(false);
      expect(f.session.agentState).toBe("processing");
    } finally { f.runtime.close(); }
  });
});
