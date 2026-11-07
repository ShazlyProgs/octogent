import { vi } from "vitest";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCodexProviderEventRoute } from "../src/createApiServer/providerEventRoutes";
import { RuntimeInputError } from "../src/terminalRuntime/types";

const serve = async (runtime: unknown) => {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleCodexProviderEventRoute({ request, response, requestUrl: new URL(request.url ?? "/", "http://127.0.0.1"), corsOrigin: null } as never, { runtime } as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address(); if (!a || typeof a === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${a.port}/api/provider-events/codex` };
};
const post = (url: string, body: unknown, headers: Record<string, string> = { "X-Octogent-Session": "terminal-2", "X-Octogent-Provider-Token": "cap" }) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("P36 provider-event reject journal", () => {
  it("a mismatched completion is still rejected (409) and logged once, without the token", async () => {
    const logs: any[] = [];
    const runtime = { recordCodexProviderEvent: () => { throw new RuntimeInputError("Codex completion does not match the active process generation and turn."); }, logProviderEventReject: (d: unknown) => logs.push(d) };
    const { server, url } = await serve(runtime);
    try {
      const res = await post(url, { type: "agent-turn-complete", "thread-id": "th", "turn-id": "tu", "octogent-turn-id": "x", "octogent-process-generation": 1 });
      expect(res.status).toBe(409);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ terminalId: "terminal-2", status: 409, tokenPresent: true });
      expect(String(logs[0].reason)).toContain("does not match");
    } finally { server.close(); }
  });
  it("a valid completion is applied (202) and not logged", async () => {
    const logs: unknown[] = []; let applied = 0;
    const runtime = { recordCodexProviderEvent: () => { applied++; return { accepted: true }; }, logProviderEventReject: (d: unknown) => logs.push(d) };
    const { server, url } = await serve(runtime);
    try { expect((await post(url, { type: "agent-turn-complete" })).status).toBe(202); expect(applied).toBe(1); expect(logs).toHaveLength(0); } finally { server.close(); }
  });
  it("missing session header is rejected (400) and logged", async () => {
    const logs: any[] = [];
    const { server, url } = await serve({ recordCodexProviderEvent: () => ({}), logProviderEventReject: (d: unknown) => logs.push(d) });
    try { expect((await post(url, {}, {})).status).toBe(400); expect(logs[0]).toMatchObject({ status: 400, terminalId: "" }); } finally { server.close(); }
  });
});

describe("P36 notify hook failure log", () => {
  const run = (port: number, home: string) => new Promise<{ code: number | null; ms: number }>((done) => {
    const t0 = Date.now();
    const payload = JSON.stringify({ type: "agent-turn-complete", "input-messages": ['x <octogent-turn process-generation="1" id="t1" />'] });
    const p = spawn(process.execPath, [resolve(import.meta.dirname, "..", "src", "codexLifecycleNotify.cjs"), "1", payload],
      { env: { ...process.env, HOME: home, USERPROFILE: home, OCTOGENT_SESSION_ID: "terminal-hook", OCTOGENT_API_ORIGIN: `http://127.0.0.1:${port}`, OCTOGENT_PROVIDER_EVENT_TOKEN: "cap" }, stdio: "ignore" });
    p.once("exit", (code) => done({ code, ms: Date.now() - t0 }));
  });
  it("records a failed post when the port is closed and exits quickly", async () => {
    const home = mkdtempSync(join(tmpdir(), "p36-hook-"));
    try {
      const r = await run(1, home);
      expect(r.code).toBe(0); expect(r.ms).toBeLessThan(4000);
      const f = join(home, ".octogent", "codex-notify-failures.jsonl"); expect(existsSync(f)).toBe(true);
      const line = JSON.parse(readFileSync(f, "utf8").trim().split("\n").pop()!);
      expect(line).toMatchObject({ terminalId: "terminal-hook", status: null }); expect(String(line.error)).not.toContain("cap");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("records a non-2xx status", async () => {
    const home = mkdtempSync(join(tmpdir(), "p36-hook-"));
    const server = createServer((_q, s) => { s.writeHead(409).end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); const a = server.address() as { port: number };
    try {
      const r = await run(a.port, home); expect(r.code).toBe(0);
      const line = JSON.parse(readFileSync(join(home, ".octogent", "codex-notify-failures.jsonl"), "utf8").trim());
      expect(line.status).toBe(409);
    } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
