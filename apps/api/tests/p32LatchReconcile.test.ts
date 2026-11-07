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

describe("P32 latch reconcile", () => {
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
  const envKeys = ["OCTO_LATCH_RECONCILE", "OCTO_LATCH_RECONCILE_MS"] as const;
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

  it("P32 msg132: delivery written + Enter, no rollout input -> latch clears after N min and is flagged", async () => {
    vi.useFakeTimers(); process.env.OCTO_LATCH_RECONCILE = "1"; process.env.OCTO_LATCH_RECONCILE_MS = "180000";
    const f = await liveCodex();
    try {
      const before = new Date(Date.now() - 600_000).toISOString(); // last task_complete 10 min before delivery
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}Read DISPATCH-native-headroom-2015b.md${BP_END}\r`)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000); // composer Enter written
      expect(f.session.agentState).toBe("processing");
      const truth = deriveCodexTruth(line("task_complete", before));
      expect(f.runtime.reconcileLatch(f.tentacleId, truth)).toBe(false); // too early
      await vi.advanceTimersByTimeAsync(180_000);
      expect(f.runtime.reconcileLatch(f.tentacleId, truth)).toBe(true);
      expect(f.session.agentState).toBe("idle");
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}resend${BP_END}\r`)).toBe(true); // deliverable again
    } finally { f.runtime.close(); }
  });

  it("P32 never clears an open turn (task_started or user_message after, or before, the delivery)", async () => {
    vi.useFakeTimers(); process.env.OCTO_LATCH_RECONCILE = "1"; process.env.OCTO_LATCH_RECONCILE_MS = "1000";
    const f = await liveCodex();
    try {
      const old = new Date(Date.now() - 600_000).toISOString();
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}x${BP_END}\r`)).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      const after = new Date().toISOString();
      for (const t of [line("task_started", after), line("user_message", after), line("task_started", old)]) {
        expect(f.runtime.reconcileLatch(f.tentacleId, deriveCodexTruth(t))).toBe(false);
      }
      expect(f.runtime.reconcileLatch(f.tentacleId, deriveCodexTruth(null))).toBe(false); // unknown
      expect(f.runtime.reconcileLatch(f.tentacleId, deriveCodexTruth(line("task_complete", after)))).toBe(false); // completion after delivery: legacy path owns it
      expect(f.session.agentState).toBe("processing");
    } finally { f.runtime.close(); }
  });

  it("P32 flag off: never reconciles", async () => {
    vi.useFakeTimers(); Reflect.deleteProperty(process.env, "OCTO_LATCH_RECONCILE"); process.env.OCTO_LATCH_RECONCILE_MS = "1000";
    const f = await liveCodex();
    try {
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}x${BP_END}\r`)).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.runtime.reconcileLatch(f.tentacleId, deriveCodexTruth(line("task_complete", new Date(Date.now() - 600_000).toISOString())))).toBe(false);
      expect(f.session.agentState).toBe("processing");
    } finally { f.runtime.close(); }
  });

  it("P32 watchdog arms at delivery, before the composer Enter", async () => {
    vi.useFakeTimers(); process.env.OCTO_LATCH_RECONCILE = "1";
    const f = await liveCodex(100);
    try {
      expect(f.runtime.writeInput(f.tentacleId, `${BP_START}x${BP_END}`)).toBe(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(f.runtime.isCodexTurnTimedOut(f.tentacleId)).toBe(true);
    } finally { f.runtime.close(); }
  });

  it("P32 shouldReconcileLatch pure rules", () => {
    const now = Date.parse("2026-11-02T19:41:00Z"); const sub = Date.parse("2026-11-02T19:37:55Z");
    const idleOld = deriveCodexTruth(line("task_complete", "2026-11-02T19:28:01Z"));
    const base = { turnId: "t", submittedAtMs: sub, legacy: "processing", nowMs: now, thresholdMs: 180_000 };
    expect(shouldReconcileLatch({ ...base, truth: idleOld })).toBe(true);
    expect(shouldReconcileLatch({ ...base, truth: idleOld, nowMs: sub + 60_000 })).toBe(false);
    expect(shouldReconcileLatch({ ...base, truth: idleOld, legacy: "idle" })).toBe(false);
    expect(shouldReconcileLatch({ ...base, truth: deriveCodexTruth(line("task_started", "2026-11-02T19:38:05Z")) })).toBe(false);
  });
});
