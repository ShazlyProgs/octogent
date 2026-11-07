import { describe, expect, it, vi } from "vitest";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { handleChannelSupersedeRoute } from "../src/createApiServer/miscRoutes";
import type { RouteHandlerDependencies } from "../src/createApiServer/routeHelpers";
import { createChannelMessaging } from "../src/terminalRuntime/channelMessaging";
import type { PersistedTerminal, TerminalSession } from "../src/terminalRuntime/types";

const expectedSession = { instanceId: "i1", projectStateId: "p1", tentacleId: "t1", processId: 7, startedAt: "2026-11-01T00:00:00Z" };

function fixture() {
  const session = { agentState: "busy" } as unknown as TerminalSession;
  const writeInput = vi.fn((_id: string, _data: string) => true);
  const channels = createChannelMessaging({
    terminals: new Map([["terminal-12", { tentacleName: "PPE" } as PersistedTerminal]]),
    sessions: new Map([["terminal-12", session]]),
    writeInput,
  });
  const runtime = { ...channels, listTerminalSnapshots: () => [{ ...expectedSession, terminalId: "terminal-12" }] };
  async function route(body: unknown, method = "POST") {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
    request.method = method;
    let status = 0;
    let result: Record<string, unknown> = {};
    const response = { writeHead(c: number) { status = c; }, end(raw: string) { result = JSON.parse(raw); } } as unknown as ServerResponse;
    await handleChannelSupersedeRoute(
      { request, response, requestUrl: new URL("http://localhost/api/channels/terminal-12/messages/supersede"), corsOrigin: null },
      { runtime } as unknown as RouteHandlerDependencies,
    );
    return { status, result };
  }
  return { session, channels, writeInput, route };
}
const body = (ids: string[], extra: Record<string, unknown> = {}) => ({ expectedSession, messageIds: ids, supersededBy: "grok", reason: "stale", custodyRef: "custody.md", ...extra });

describe("channel supersede", () => {
  it("marks undelivered messages superseded, keeps them, and unblocks guarded sends", async () => {
    const f = fixture();
    const a = f.channels.sendChannelMessage("terminal-12", "terminal-17", "old A");
    const b = f.channels.sendChannelMessage("terminal-12", "terminal-17", "old B");
    expect(f.channels.sendChannelMessage("terminal-12", "terminal-17", "x", { immediateOnly: true })).toBeNull();
    const r = await f.route(body([a!.messageId, b!.messageId]));
    expect(r.status).toBe(200);
    const list = f.channels.listChannelMessages("terminal-12");
    expect(list).toHaveLength(2);
    expect(list.every((m) => !m.delivered && m.superseded?.by === "grok" && m.superseded.reason === "stale")).toBe(true);
    expect(list[0]?.content).toBe("old A");
    f.session.agentState = "idle";
    f.channels.deliverChannelMessages("terminal-12");
    expect(f.writeInput).not.toHaveBeenCalled();
    const fresh = f.channels.sendChannelMessage("terminal-12", "terminal-17", "C6", { immediateOnly: true });
    expect(fresh?.delivered).toBe(true);
    expect(f.writeInput).toHaveBeenCalledTimes(1);
    expect(String(f.writeInput.mock.calls[0]?.[1])).not.toContain("old A");
  });
  it("is idempotent and fails closed on unknown or delivered ids with no change", async () => {
    const f = fixture();
    const a = f.channels.sendChannelMessage("terminal-12", "terminal-17", "old A")!;
    const b = f.channels.sendChannelMessage("terminal-12", "terminal-17", "old B")!;
    expect((await f.route(body([a.messageId]))).status).toBe(200);
    const again = await f.route(body([a.messageId]));
    expect(again.status).toBe(200);
    expect(again.result.alreadySuperseded).toEqual([a.messageId]);
    const bad = await f.route(body([b.messageId, "msg-999"]));
    expect(bad.status).toBe(409);
    expect(f.channels.listChannelMessages("terminal-12")[1]?.superseded).toBeUndefined();
    f.session.agentState = "idle";
    f.channels.deliverChannelMessages("terminal-12");
    const done = await f.route(body([b.messageId]));
    expect(done.status).toBe(409);
    expect(done.result.error).toBe("already-delivered");
  });
  it("rejects session mismatch and malformed bodies", async () => {
    const f = fixture();
    const a = f.channels.sendChannelMessage("terminal-12", "terminal-17", "old A")!;
    expect((await f.route(body([a.messageId], { expectedSession: { ...expectedSession, processId: 8 } }))).status).toBe(409);
    expect((await f.route(body([a.messageId], { reason: "" }))).status).toBe(400);
    expect((await f.route(body(["drop table"]))).status).toBe(400);
    expect((await f.route(body([a.messageId]), "GET")).status).toBe(405);
    expect(f.channels.listChannelMessages("terminal-12")[0]?.superseded).toBeUndefined();
  });
});

