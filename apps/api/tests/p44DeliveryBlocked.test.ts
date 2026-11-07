import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: spawnMock }));
vi.mock("../src/terminalRuntime/ptyEnvironment", () => ({
  createShellEnvironment: vi.fn(() => ({})),
  ensureNodePtySpawnHelperExecutable: vi.fn(),
}));

import { handleConversationMessagesRoute } from "../src/createApiServer/conversationRoutes";
import { handleTerminalDeliveryBlockClearRoute } from "../src/createApiServer/terminalRoutes";
import { createSessionRuntime } from "../src/terminalRuntime/sessionRuntime";
import { createTerminalRuntime, type GitClient } from "../src/terminalRuntime";
import type { PersistedTerminal, TerminalSession } from "../src/terminalRuntime/types";

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
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";
const TEXT = "Read Claude Cowork/handoffs/2026-11-03-vaultagent-DISPATCH-native-abi-proposal-0905.md";
const ev = (type: string, ms: number) =>
  JSON.stringify({ timestamp: new Date(ms).toISOString(), type: "event_msg", payload: { type } });

const noopGit = (): GitClient => ({ assertAvailable() {}, isRepository: () => true }) as unknown as GitClient;

describe("P44 deliveryBlocked clears and reports 409", () => {
  const temporaryDirectories: string[] = [];
  const createTemporaryDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "octogent-p44-"));
    temporaryDirectories.push(directory);
    return directory;
  };

  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
    process.env.OCTO_ENTER_RETRY = "1";
    process.env.OCTO_ENTER_RETRY_MS = "1000";
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(process.env, "OCTO_ENTER_RETRY");
    Reflect.deleteProperty(process.env, "OCTO_ENTER_RETRY_MS");
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.length = 0;
  });

  const setupHome = (id: string) => {
    const home = createTemporaryDirectory();
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    const dir = join(home, ".codex", "sessions", "2026", "11", "03");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-11-03T08-00-00-${id}.jsonl`);
    writeFileSync(file, ev("task_complete", Date.now() - 60_000) + "\n");
    return file;
  };

  const startCodex = (id: string) => {
    const tentacleId = "terminal-17";
    const terminals = new Map<string, PersistedTerminal>([
      [
        tentacleId,
        {
          terminalId: tentacleId,
          tentacleId,
          tentacleName: "VA",
          createdAt: new Date().toISOString(),
          workspaceMode: "shared",
          agentProvider: "codex",
          codexThreadId: id,
        },
      ],
    ]);
    const sessions = new Map<string, TerminalSession>();
    const pty = new FakePty();
    spawnMock.mockReturnValue(pty);
    const runtime = createSessionRuntime({
      websocketServer: { handleUpgrade: vi.fn() } as never,
      terminals,
      sessions,
      getTentacleWorkspaceCwd: () => process.cwd(),
      isDebugPtyLogsEnabled: false,
      ptyLogDir: process.cwd(),
      transcriptDirectoryPath: createTemporaryDirectory(),
    });
    expect(runtime.startSession(tentacleId)).toBe(true);
    const session = sessions.get(tentacleId);
    if (!session) throw new Error("expected session");
    return { runtime, pty, session, tentacleId, file: setupHome(id) };
  };

  const blockSeat = async (id: string) => {
    const seat = startCodex(id);
    expect(seat.runtime.writeInput(seat.tentacleId, `${BP_START}${TEXT}${BP_END}\r`)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    seat.pty.emitData(`> ${TEXT}`);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seat.runtime.getDeliveryBlocked(seat.tentacleId)?.reason).toBe("dirty_input_needs_clean");
    return seat;
  };

  it("sets deliveryBlocked after a failed Enter retry and refuses the next automated write", async () => {
    const seat = await blockSeat("01a1aaaa-0000-7000-8000-0000000000a1");
    expect(seat.runtime.writeInput(seat.tentacleId, `${BP_START}next prompt${BP_END}\r`)).toBe(false);
    seat.runtime.close();
  });

  it("clears the flag once Codex records task_complete and the composer line is empty", async () => {
    const seat = await blockSeat("01a1aaaa-0000-7000-8000-0000000000a2");
    seat.pty.emitData("\r\n> ");
    appendFileSync(seat.file, ev("task_complete", Date.now()) + "\n");
    await vi.advanceTimersByTimeAsync(400);
    expect(seat.runtime.getDeliveryBlocked(seat.tentacleId)).toBeUndefined();
    expect(seat.runtime.writeInput(seat.tentacleId, `${BP_START}next prompt${BP_END}\r`)).toBe(true);
    seat.runtime.close();
  });

  it("does not clear while the dirty text is still the composer line", async () => {
    const seat = await blockSeat("01a1aaaa-0000-7000-8000-0000000000a3");
    appendFileSync(seat.file, ev("task_complete", Date.now()) + "\n");
    await vi.advanceTimersByTimeAsync(400);
    expect(seat.runtime.getDeliveryBlocked(seat.tentacleId)?.reason).toBe("dirty_input_needs_clean");
    expect(seat.runtime.writeInput(seat.tentacleId, `${BP_START}next prompt${BP_END}\r`)).toBe(false);
    seat.runtime.close();
  });

  it("operator clear requires an idle seat and an empty composer, and never types", async () => {
    const seat = await blockSeat("01a1aaaa-0000-7000-8000-0000000000a4");
    const writes = seat.pty.write.mock.calls.length;
    expect(seat.runtime.clearDeliveryBlockedIfIdleAndEmpty(seat.tentacleId)).toMatchObject({
      ok: false,
      reason: "seat_not_idle",
    });
    seat.session.agentState = "idle";
    expect(seat.runtime.clearDeliveryBlockedIfIdleAndEmpty(seat.tentacleId)).toMatchObject({
      ok: false,
      reason: "composer_not_empty",
    });
    seat.pty.emitData("\r\n> ");
    expect(seat.runtime.clearDeliveryBlockedIfIdleAndEmpty(seat.tentacleId)).toEqual({ ok: true });
    expect(seat.pty.write.mock.calls.length).toBe(writes);
    expect(seat.runtime.getDeliveryBlocked(seat.tentacleId)).toBeUndefined();
    seat.runtime.close();
  });

  it("POST /api/conversations/:id/messages returns 409 delivery_blocked instead of 404", async () => {
    const id = "01a1aaaa-0000-7000-8000-0000000000a5";
    const file = setupHome(id);
    const pty = new FakePty();
    spawnMock.mockReturnValue(pty);
    const workspaceCwd = createTemporaryDirectory();
    const runtime = createTerminalRuntime({ workspaceCwd, gitClient: noopGit() });
    runtime.createTerminal({
      terminalId: "terminal-17",
      workspaceMode: "shared",
      agentProvider: "codex",
      codexThreadId: id,
      initialPrompt: "boot",
    });
    expect(runtime.writeInput("terminal-17", `${BP_START}${TEXT}${BP_END}\r`)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    pty.emitData(`> ${TEXT}`);
    await vi.advanceTimersByTimeAsync(2000);
    const snapshot = runtime.listTerminalSnapshots().find((row) => row.terminalId === "terminal-17");
    expect(snapshot?.deliveryBlocked).toBe(true);
    expect(snapshot?.deliveryBlockedReason).toBe("dirty_input_needs_clean");

    const submit = runtime.submitConversationMessage("terminal-17", "follow up");
    expect(submit).toMatchObject({
      status: "delivery-blocked",
      reason: "delivery_blocked",
      deliveryBlockedReason: "dirty_input_needs_clean",
    });

    const request = Readable.from([Buffer.from(JSON.stringify({ content: "follow up" }))]) as IncomingMessage;
    request.method = "POST";
    let status = 0;
    let body: Record<string, unknown> = {};
    const response = {
      writeHead(code: number) {
        status = code;
      },
      end(raw: string) {
        body = JSON.parse(raw) as Record<string, unknown>;
      },
    } as unknown as ServerResponse;
    await handleConversationMessagesRoute(
      {
        request,
        response,
        requestUrl: new URL("http://127.0.0.1/api/conversations/terminal-17/messages"),
        corsOrigin: null,
      },
      { runtime } as never,
    );
    expect(status).toBe(409);
    expect(body.reason).toBe("delivery_blocked");
    expect(file).toBeTruthy();

    const clearRequest = Readable.from([Buffer.from("{}")]) as IncomingMessage;
    clearRequest.method = "POST";
    let clearStatus = 0;
    let clearBody: Record<string, unknown> = {};
    const clearResponse = {
      writeHead(code: number) {
        clearStatus = code;
      },
      end(raw: string) {
        clearBody = JSON.parse(raw) as Record<string, unknown>;
      },
    } as unknown as ServerResponse;
    await handleTerminalDeliveryBlockClearRoute(
      {
        request: clearRequest,
        response: clearResponse,
        requestUrl: new URL("http://127.0.0.1/api/terminals/terminal-17/delivery-block/clear"),
        corsOrigin: null,
      },
      { runtime } as never,
    );
    expect(clearStatus).toBe(409);
    expect(clearBody.reason === "seat_not_idle" || clearBody.reason === "composer_not_empty").toBe(true);
    await runtime.close();
  });
});
