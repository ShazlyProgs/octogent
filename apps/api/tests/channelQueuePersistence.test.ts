import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelMessaging } from "../src/terminalRuntime/channelMessaging";
import type { PersistedTerminal, TerminalSession } from "../src/terminalRuntime/types";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(dir?: string) {
  const root = dir ?? mkdtempSync(join(tmpdir(), "octo-x2-"));
  if (!dir) dirs.push(root);
  const persistence = { queuePath: join(root, "state", "channel-queue.jsonl"), deadLetterPath: join(root, "state", "channel-deadletter.jsonl") };
  let clock = Date.parse("2026-11-01T18:00:00Z");
  const session = { agentState: "busy" } as unknown as TerminalSession;
  const writeInput = vi.fn((_id: string, _d: string) => true);
  const onDeadLetter = vi.fn();
  const channels = createChannelMessaging({
    terminals: new Map([["terminal-12", { tentacleName: "PPE" } as PersistedTerminal], ["terminal-17", { tentacleName: "VA" } as PersistedTerminal]]),
    sessions: new Map([["terminal-12", session]]),
    writeInput, persistence, onDeadLetter, now: () => clock,
  });
  return { root, persistence, session, writeInput, onDeadLetter, channels, advance: (ms: number) => { clock += ms; } };
}
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("X2 persistent channel queue", () => {
  it("survives a simulated restart with unique ids and pending state", () => {
    const a = setup();
    const m1 = a.channels.sendChannelMessage("terminal-12", "terminal-17", "one")!;
    const m2 = a.channels.sendChannelMessage("terminal-12", "terminal-17", "two")!;
    expect([m1.messageId, m2.messageId]).toEqual(["msg-1", "msg-2"]);
    // restart: new instance, same state dir
    const b = setup(a.root);
    const list = b.channels.listChannelMessages("terminal-12");
    expect(list.map((m) => m.messageId)).toEqual(["msg-1", "msg-2"]);
    expect(list.every((m) => !m.delivered)).toBe(true);
    expect(b.channels.sendChannelMessage("terminal-12", "terminal-17", "three")!.messageId).toBe("msg-3");
    b.session.agentState = "idle";
    b.channels.deliverChannelMessages("terminal-12");
    expect(b.writeInput).toHaveBeenCalledTimes(1);
    // delivered state persists; second restart does not redeliver
    const c = setup(a.root);
    c.session.agentState = "idle";
    c.channels.deliverChannelMessages("terminal-12");
    expect(c.writeInput).not.toHaveBeenCalled();
    expect(c.channels.listChannelMessages("terminal-12").every((m) => m.delivered)).toBe(true);
    // compaction: one record per message
    expect(lines(a.persistence.queuePath)).toHaveLength(3);
  });

  it("expires after 45 min, dead-letters with a one-line notice and never retypes", () => {
    const a = setup();
    a.channels.sendChannelMessage("terminal-12", "terminal-17", "stale");
    a.advance(44 * 60 * 1000);
    expect(a.channels.listChannelMessages("terminal-12")[0]?.expired).toBeUndefined();
    a.advance(2 * 60 * 1000);
    a.session.agentState = "idle";
    a.channels.deliverChannelMessages("terminal-12");
    expect(a.writeInput).not.toHaveBeenCalled();
    const [dl] = lines(a.persistence.deadLetterPath);
    expect(dl.reason).toBe("expired");
    expect(dl.notice).toBe("msg-1 to terminal-12 expired after 45m undelivered; re-dispatch or drop");
    expect(dl.notice).not.toContain("\n");
    expect(a.onDeadLetter).toHaveBeenCalledTimes(1);
    // expired does not block a guarded send, and survives restart as expired
    expect(a.channels.sendChannelMessage("terminal-12", "terminal-17", "fresh", { immediateOnly: true })?.delivered).toBe(true);
    expect(String(a.writeInput.mock.calls[0]?.[1])).not.toContain("stale");
    const b = setup(a.root);
    expect(b.channels.listChannelMessages("terminal-12")[0]?.expired?.afterMs).toBe(45 * 60 * 1000);
    expect(lines(a.persistence.deadLetterPath)).toHaveLength(1);
  });

  it("held seats get 2 h before expiry", () => {
    const a = setup();
    a.session.agentState = "held" as TerminalSession["agentState"];
    a.channels.sendChannelMessage("terminal-12", "terminal-17", "wait");
    a.advance(90 * 60 * 1000);
    a.channels.sweepExpiredChannelMessages();
    expect(lines(a.persistence.deadLetterPath)).toHaveLength(0);
    a.advance(31 * 60 * 1000);
    a.channels.sweepExpiredChannelMessages();
    const [dl] = lines(a.persistence.deadLetterPath);
    expect(dl.notice).toContain("expired after 120m undelivered (seat held)");
  });

  it("supersedes by unit key and dead-letters superseded messages (route path too)", () => {
    const a = setup();
    const old = a.channels.sendChannelMessage("terminal-12", "terminal-17", "C6 v1", { supersedeKey: "C6" })!;
    const other = a.channels.sendChannelMessage("terminal-12", "terminal-17", "L3", { supersedeKey: "L3" })!;
    a.channels.sendChannelMessage("terminal-12", "terminal-17", "C6 v2", { supersedeKey: "C6" });
    const list = a.channels.listChannelMessages("terminal-12");
    expect(list.find((m) => m.messageId === old.messageId)?.superseded?.reason).toBe("superseded-by-key");
    expect(list.find((m) => m.messageId === other.messageId)?.superseded).toBeUndefined();
    expect(a.channels.supersedeChannelMessages("terminal-12", [other.messageId], { by: "grok", reason: "stale" }).ok).toBe(true);
    a.session.agentState = "idle";
    a.channels.deliverChannelMessages("terminal-12");
    expect(a.writeInput).toHaveBeenCalledTimes(1);
    expect(String(a.writeInput.mock.calls[0]?.[1])).toContain("C6 v2");
    expect(String(a.writeInput.mock.calls[0]?.[1])).not.toContain("C6 v1");
    expect(lines(a.persistence.deadLetterPath).map((d) => d.reason)).toEqual(["superseded", "superseded"]);
  });

  it("without persistence behaves in-memory (supersede-only fallback)", () => {
    const writeInput = vi.fn(() => true);
    const ch = createChannelMessaging({ terminals: new Map([["t", {} as PersistedTerminal]]), sessions: new Map(), writeInput });
    expect(ch.sendChannelMessage("t", "s", "hi")?.messageId).toBe("msg-1");
  });
});
