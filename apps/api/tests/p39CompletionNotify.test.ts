import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompletionNotifier, deriveTaskId, COMPLETION_PING_PREFIX } from "../src/terminalRuntime/completionNotify";
import { deriveClaudeTruth, deriveCodexTruth, isUiStatusFixEnabled } from "../src/terminalRuntime/logTruth";

const NAMES: Record<string, string> = { "terminal-17": "VaultAgent", "terminal-5": "CISO", "terminal-10": "CTO", "terminal-3": "Platform Team Lead" };
const T0 = Date.parse("2026-11-04T18:39:47.683Z");
const mk = (env: Record<string, string>, opts: { sendResult?: (to: string) => { messageId: string; delivered: boolean } | null; now?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "p39-")); const handoffs = join(dir, "handoffs"); mkdirSync(handoffs);
  const sent: Array<{ to: string; from: string; content: string }> = []; let n = 0; let clock = opts.now ?? T0 + 10 * 60_000;
  const notifier = createCompletionNotifier({ stateDir: join(dir, "state"), publicPath: join(dir, "public", "completions.jsonl"), handoffsDir: handoffs,
    name: (id) => NAMES[id] ?? id, isTerminal: (id) => id in NAMES, now: () => clock, env: env as NodeJS.ProcessEnv,
    send: (to, from, content) => { sent.push({ to, from, content }); return opts.sendResult ? opts.sendResult(to) : { messageId: `msg-${++n}`, delivered: true }; } });
  return { dir, handoffs, sent, notifier, setNow: (t: number) => { clock = t; } };
};
const dispatch = (from: string, to: string, file: string, at = T0, id = "msg-320") => ({ messageId: id, fromTerminalId: from, toTerminalId: to, content: `Read Claude Cowork/handoffs/${file}. Gate x. Finite RESULT then HOLD.`, timestamp: new Date(at).toISOString(), deliveredAt: new Date(at).toISOString() });
const done = (at: number, event = "end_turn") => ({ state: "idle", event, eventAt: new Date(at).toISOString() });
const ON = { OCTO_COMPLETION_NOTIFY: "1", OCTO_COMPLETION_NOTIFY_TYPE: "1", OCTO_COMPLETION_NOTIFY_SETTLE_MS: "5000" };

describe("P39 completion notify", () => {
  it("derives the task id from the dispatch filename", () => {
    expect(deriveTaskId("Read Claude Cowork/handoffs/2026-11-04-vaultagent-DISPATCH-x10-delta-security-1927.md. Gate", "msg-1")).toBe("x10-delta-security-1927");
    expect(deriveTaskId("please look", "msg-9")).toBe("msg-9");
  });
  it("flags off: nothing tracked or sent", () => {
    const h = mk({}); h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "x-DISPATCH-a-1927.md"));
    expect(h.notifier.observe("terminal-5", done(T0 + 60_000))).toEqual([]); expect(h.sent).toEqual([]);
  });
  it("idle waiter: one SEAT DONE line naming worker, task and result file; journals both files", () => {
    const h = mk(ON);
    writeFileSync(join(h.handoffs, "2026-11-04-fleet-ciso-to-vaultagent-RESULT-x10-delta-security-1927.md"), "r");
    h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "2026-11-04-vaultagent-DISPATCH-x10-delta-security-1927.md"));
    const ev = h.notifier.observe("terminal-5", done(Date.parse("2026-11-04T18:45:39.061Z")));
    expect(ev).toHaveLength(1); expect(ev[0]!.status).toBe("delivered"); expect(ev[0]!.waiterName).toBe("VaultAgent");
    expect(h.sent).toEqual([{ to: "terminal-17", from: "terminal-5", content: `${COMPLETION_PING_PREFIX} CISO, x10-delta-security-1927, result: 2026-11-04-fleet-ciso-to-vaultagent-RESULT-x10-delta-security-1927.md` }]);
    expect(readFileSync(join(h.dir, "state", "completion-notify.jsonl"), "utf8")).toContain("x10-delta-security-1927");
    expect(readFileSync(join(h.dir, "public", "completions.jsonl"), "utf8")).toContain("\"workerName\":\"CISO\"");
  });
  it("any waiter: the sender is the waiter (not hardcoded VA); unknown sender falls back to VaultAgent", () => {
    const h = mk(ON);
    h.notifier.recordDispatch(dispatch("terminal-3", "terminal-10", "DISPATCH-build-1.md"));
    h.notifier.recordDispatch({ ...dispatch("", "terminal-5", "DISPATCH-sec-2.md"), messageId: "msg-2" });
    h.notifier.observe("terminal-10", done(T0 + 60_000)); h.notifier.observe("terminal-5", done(T0 + 60_000));
    expect(h.sent.map((s) => s.to)).toEqual(["terminal-3", "terminal-17"]);
  });
  it("busy waiter: send is queued by the channel (status queued), never typed directly", () => {
    const h = mk(ON, { sendResult: () => ({ messageId: "msg-7", delivered: false }) });
    h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md"));
    expect(h.notifier.observe("terminal-5", done(T0 + 60_000))[0]!.status).toBe("queued");
  });
  it("coalesces several completions for one waiter into one line", () => {
    const h = mk(ON);
    h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md", T0, "m1"));
    h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-b-2.md", T0 + 1000, "m2"));
    const ev = h.notifier.observe("terminal-5", done(T0 + 60_000));
    expect(ev).toHaveLength(2); expect(h.sent).toHaveLength(1); expect(h.sent[0]!.content).toBe(`${COMPLETION_PING_PREFIX} CISO, a-1, result: not found; CISO, b-2, result: not found`);
  });
  it("dedup: the same completion is never delivered twice, including across restarts (shared seen-state file)", () => {
    const h = mk(ON); h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md"));
    h.notifier.observe("terminal-5", done(T0 + 60_000)); h.notifier.observe("terminal-5", done(T0 + 60_000));
    expect(h.sent).toHaveLength(1);
    const seen = JSON.parse(readFileSync(join(h.dir, "state", "completion-notify.json"), "utf8")).seen as string[];
    expect(seen).toContain(`terminal-5|a-1|${new Date(T0 + 60_000).toISOString()}`);
    const again = createCompletionNotifier({ stateDir: join(h.dir, "state"), publicPath: null, name: (id) => id, isTerminal: () => true, now: () => T0 + 600_000, env: ON as NodeJS.ProcessEnv, send: () => { throw new Error("must not send"); } });
    again.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md"));
    expect(again.observe("terminal-5", done(T0 + 60_000))).toEqual([]);
  });
  it("only a completion AFTER the delivery closes the edge; settle delay respected", () => {
    const h = mk(ON); h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md"));
    expect(h.notifier.observe("terminal-5", done(T0 - 1000))).toEqual([]);
    h.setNow(T0 + 62_000); expect(h.notifier.observe("terminal-5", done(T0 + 60_000))).toEqual([]); // inside 5 s settle
    h.setNow(T0 + 70_000); expect(h.notifier.observe("terminal-5", done(T0 + 60_000))).toHaveLength(1);
  });
  it("our own SEAT DONE pings are never tracked (no ping loops)", () => {
    const h = mk(ON); h.notifier.recordDispatch({ ...dispatch("terminal-5", "terminal-17", "x.md"), content: `${COMPLETION_PING_PREFIX} CISO, a, result: r` });
    expect(h.notifier.openEdges("terminal-17")).toEqual([]);
  });
  it("failed ping -> status failed, retried once on the next poll", () => {
    let fail = true; const h = mk(ON, { sendResult: () => (fail ? null : { messageId: "msg-9", delivered: true }) });
    h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md"));
    expect(h.notifier.observe("terminal-5", done(T0 + 60_000))[0]!.status).toBe("failed");
    fail = false; const r = h.notifier.observe("terminal-10", { state: "working", event: "user", eventAt: null });
    expect(r[0]!.status).toBe("retry_delivered"); expect(h.sent).toHaveLength(2);
  });
  it("log-only mode (TYPE unset): journals, never sends", () => {
    const h = mk({ OCTO_COMPLETION_NOTIFY: "1" }); h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md"));
    expect(h.notifier.observe("terminal-5", done(T0 + 60_000))[0]!.status).toBe("logged"); expect(h.sent).toEqual([]);
  });
  it("Claude seat: compaction after the delivery is not a completion; Codex task_complete is", () => {
    const j = (o: unknown) => JSON.stringify(o);
    const claude = [j({ type: "user", timestamp: "2026-11-04T18:39:48Z", uuid: "u", message: { content: "[Channel message from VaultAgent]: Read ..." } }),
      j({ type: "user", timestamp: "2026-11-04T18:44:00Z", uuid: "c", isCompactSummary: true, message: { content: "continued" } })].join("\n");
    const t = deriveClaudeTruth(claude, true); expect(t.state).toBe("working");
    const h = mk(ON); h.notifier.recordDispatch(dispatch("terminal-17", "terminal-5", "DISPATCH-a-1.md"));
    expect(h.notifier.observe("terminal-5", t)).toEqual([]);
    const codex = [j({ type: "event_msg", timestamp: "2026-11-04T18:40:00Z", payload: { type: "task_started", turn_id: "x" } }), j({ type: "event_msg", timestamp: "2026-11-04T18:45:00Z", payload: { type: "task_complete", turn_id: "x" } })].join("\n");
    h.notifier.recordDispatch(dispatch("terminal-17", "terminal-10", "DISPATCH-c-3.md", T0, "m3"));
    expect(h.notifier.observe("terminal-10", deriveCodexTruth(codex))[0]!.worker).toBe("terminal-10");
  });
});
describe("P40 flag", () => {
  it("OCTO_UI_STATUS_FIX defaults off", () => { expect(isUiStatusFixEnabled({} as NodeJS.ProcessEnv)).toBe(false); expect(isUiStatusFixEnabled({ OCTO_UI_STATUS_FIX: "1" } as NodeJS.ProcessEnv)).toBe(true); });
});
