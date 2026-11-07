// P39b-wired
/**
 * P39: completion notify. Tentacle A delivers work to tentacle B over the channel -> A is B's waiter for that task.
 * When B's log shows the turn after the delivery ended (Codex task_complete / Claude end_turn; Claude compaction
 * records are already ignored by log-truth with P38), A is told by name through the normal channel queue, which
 * only types into an idle seat, coalesces pending lines, and carries the P33 Enter retry / notSubmitted flag.
 * OCTO_COMPLETION_NOTIFY=1 -> track + journal only. OCTO_COMPLETION_NOTIFY_TYPE=1 -> also send the ping.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export const isCompletionNotifyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OCTO_COMPLETION_NOTIFY === "1";
export const isCompletionNotifyTypeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.OCTO_COMPLETION_NOTIFY === "1" && env.OCTO_COMPLETION_NOTIFY_TYPE === "1";
export const completionSettleMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.OCTO_COMPLETION_NOTIFY_SETTLE_MS); return Number.isFinite(n) && n >= 0 ? n : 5_000;
};
export const DEFAULT_WAITER = "terminal-17";
export const PUBLIC_COMPLETIONS_PATH = "C:\\Users\\Public\\octogent\\completions.jsonl";
export const COMPLETION_PING_PREFIX = "SEAT DONE:";

/** Task id from the delivery text: the DISPATCH/brief file slug, else the message id. */
export const deriveTaskId = (content: string, messageId: string): string => {
  const d = /DISPATCH-([A-Za-z0-9._-]+?)\.md/i.exec(content); if (d) return d[1]!;
  const f = /([A-Za-z0-9._-]+?)(?:-brief)?\.md/.exec(content); if (f) return f[1]!;
  return messageId;
};

export type Edge = { waiter: string; worker: string; taskId: string; messageId: string; deliveredAtMs: number };
export type Truth = { state: string; event: string | null; eventAt: string | null };
export type CompletionEvent = {
  at: string; worker: string; workerName: string; taskId: string; messageId: string; completedAt: string;
  resultFile: string | null; waiter: string; waiterName: string; status: "logged" | "delivered" | "queued" | "failed" | "retry_delivered" | "retry_queued" | "superseded";
  messageIdSent?: string | null;
};

export const createCompletionNotifier = (deps: {
  stateDir: string; publicPath?: string | null; handoffsDir?: string | null;
  name: (terminalId: string) => string; isTerminal: (terminalId: string) => boolean;
  send: (to: string, from: string, content: string) => { messageId: string; delivered: boolean } | null;
  now?: () => number; env?: NodeJS.ProcessEnv;
}) => {
  const now = deps.now ?? Date.now; const env = deps.env ?? process.env;
  const open = new Map<string, Edge[]>();            // worker -> open edges
  const failed: Array<{ waiter: string; worker: string; content: string; events: CompletionEvent[] }> = [];
  const seenPath = join(deps.stateDir, "completion-notify.json");
  const seen = new Set<string>();
  try { if (existsSync(seenPath)) for (const k of (JSON.parse(readFileSync(seenPath, "utf8")).seen ?? [])) seen.add(String(k)); } catch { /* fresh */ }
  const saveSeen = () => {
    try { mkdirSync(deps.stateDir, { recursive: true }); const tmp = `${seenPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(now()).toISOString(), seen: [...seen].slice(-2000) }), "utf8"); renameSync(tmp, seenPath); } catch { /* best effort */ }
  };
  const journal = (e: CompletionEvent) => {
    const line = JSON.stringify(e) + "\n";
    for (const p of [join(deps.stateDir, "completion-notify.jsonl"), deps.publicPath ?? null]) {
      if (!p) continue; try { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, line, "utf8"); } catch { /* never break */ }
    }
  };
  const findResult = (taskId: string, sinceMs: number): string | null => {
    if (!deps.handoffsDir) return null;
    try {
      const hits = readdirSync(deps.handoffsDir).filter((n) => /RESULT/i.test(n) && n.includes(taskId))
        .map((n) => ({ n, t: statSync(join(deps.handoffsDir as string, n)).mtimeMs })).filter((x) => x.t >= sinceMs - 1000).sort((a, b) => b.t - a.t);
      return hits[0]?.n ?? null;
    } catch { return null; }
  };
  const seenKey = (worker: string, taskId: string, completedAt: string) => `${worker}|${taskId}|${completedAt}`;

  return {
    /** Record a delivered/queued channel message as a dispatch edge. Ignores our own pings (no ping loops). */
    recordDispatch(m: { messageId: string; fromTerminalId: string; toTerminalId: string; content: string; timestamp: string; deliveredAt?: string }) {
      if (!isCompletionNotifyEnabled(env)) return;
      if (m.content.startsWith(COMPLETION_PING_PREFIX)) return;
      const waiter = m.fromTerminalId && deps.isTerminal(m.fromTerminalId) && m.fromTerminalId !== m.toTerminalId ? m.fromTerminalId : DEFAULT_WAITER;
      if (waiter === m.toTerminalId) return;
      const list = open.get(m.toTerminalId) ?? [];
      list.push({ waiter, worker: m.toTerminalId, taskId: deriveTaskId(m.content, m.messageId), messageId: m.messageId, deliveredAtMs: Date.parse(m.deliveredAt ?? m.timestamp) });
      open.set(m.toTerminalId, list);
    },
    /** Called on each log-truth poll. Returns the events emitted (for tests). */
    observe(worker: string, truth: Truth): CompletionEvent[] {
      if (!isCompletionNotifyEnabled(env)) return [];
      const out: CompletionEvent[] = [];
      // one retry of a failed ping per poll
      for (let i = failed.length - 1; i >= 0; i--) {
        const f = failed[i]!; const r = deps.send(f.waiter, f.worker, f.content);
        if (r) { failed.splice(i, 1); for (const e of f.events) { const ev = { ...e, at: new Date(now()).toISOString(), status: (r.delivered ? "retry_delivered" : "retry_queued") as CompletionEvent["status"], messageIdSent: r.messageId }; journal(ev); out.push(ev); } }
      }
      const list = open.get(worker);
      if (!list || list.length === 0) return out;
      const done = truth.state === "idle" && (truth.event === "task_complete" || truth.event === "end_turn" || truth.event === "turn_aborted") && truth.eventAt;
      if (!done) return out;
      const endMs = Date.parse(truth.eventAt as string);
      if (now() - endMs < completionSettleMs(env)) return out;   // settle: let the RESULT file land
      const closed = list.filter((e) => e.deliveredAtMs < endMs);
      if (closed.length === 0) return out;
      open.set(worker, list.filter((e) => !closed.includes(e)));
      const byWaiter = new Map<string, CompletionEvent[]>();
      for (const e of closed) {
        const key = seenKey(worker, e.taskId, truth.eventAt as string);
        if (seen.has(key)) continue; seen.add(key);
        const ev: CompletionEvent = { at: new Date(now()).toISOString(), worker, workerName: deps.name(worker), taskId: e.taskId, messageId: e.messageId,
          completedAt: truth.eventAt as string, resultFile: findResult(e.taskId, e.deliveredAtMs), waiter: e.waiter, waiterName: deps.name(e.waiter), status: "logged" };
        const g = byWaiter.get(e.waiter) ?? []; g.push(ev); byWaiter.set(e.waiter, g);
      }
      saveSeen();
      for (const [waiter, evs] of byWaiter) {
        if (isCompletionNotifyTypeEnabled(env)) {
          // coalesce: one line per waiter per completion pass
          const content = `${COMPLETION_PING_PREFIX} ${evs.map((x) => `${x.workerName}, ${x.taskId}, result: ${x.resultFile ?? "not found"}`).join("; ")}`;
          const r = deps.send(waiter, worker, content);
          for (const ev of evs) { ev.status = r ? (r.delivered ? "delivered" : "queued") : "failed"; ev.messageIdSent = r?.messageId ?? null; }
          if (!r) failed.push({ waiter, worker, content, events: evs });
        }
        for (const ev of evs) { journal(ev); out.push(ev); }
      }
      return out;
    },
    /** P39b: a queued SEAT DONE ping dropped as stale (the waiter already ran a turn after it was queued). */
    journalSuperseded(m: { messageId: string; fromTerminalId: string; toTerminalId: string; content: string; timestamp: string }) {
      const task = /^SEAT DONE: [^,]+, ([^,]+),/.exec(m.content)?.[1] ?? "unknown";
      journal({ at: new Date(now()).toISOString(), worker: m.fromTerminalId, workerName: deps.name(m.fromTerminalId), taskId: task, messageId: m.messageId,
        completedAt: m.timestamp, resultFile: /result: (.+)$/.exec(m.content)?.[1] ?? null, waiter: m.toTerminalId, waiterName: deps.name(m.toTerminalId), status: "superseded", messageIdSent: m.messageId });
    },
    hasSeen: (worker: string, taskId: string, completedAt: string) => seen.has(seenKey(worker, taskId, completedAt)),
    openEdges: (worker: string) => [...(open.get(worker) ?? [])],
  };
};

/** P39b: SEAT DONE delivery to a waiter whose own state is "held" (OCTO_COMPLETION_NOTIFY_HELD_OK=1). */
export const isCompletionNotifyHeldOkEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.OCTO_COMPLETION_NOTIFY === "1" && env.OCTO_COMPLETION_NOTIFY_TYPE === "1" && env.OCTO_COMPLETION_NOTIFY_HELD_OK === "1";
export const completionSettleWaiterMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.OCTO_COMPLETION_NOTIFY_SETTLE_WAITER_MS); return Number.isFinite(n) && n >= 0 ? n : 15_000;
};
export const SEAT_DONE_RECENT_INPUT_MS = 10_000;
export const isSeatDonePing = (content: string): boolean => content.startsWith(COMPLETION_PING_PREFIX);
export type SeatDoneFacts = {
  provider: string | null; agentState: string; unqualified: boolean; holdReason: string | null; timedOut: boolean;
  logState: string; lastEvent: string | null; lastCompleteAtMs: number | null; lastTurnStartedAtMs: number | null;
  heldActivity: boolean; pendingInput: boolean; lastInputAtMs: number | null; nowMs: number; settleMs: number;
};
/** Stale = the waiter started AND finished a turn after the ping was queued (someone else already woke it). Codex only. */
export const isSeatDoneStale = (f: SeatDoneFacts, queuedAtMs: number): boolean =>
  f.provider === "codex" && f.logState === "idle" && f.lastTurnStartedAtMs !== null && f.lastCompleteAtMs !== null &&
  f.lastTurnStartedAtMs > queuedAtMs && f.lastCompleteAtMs >= f.lastTurnStartedAtMs;
/** "deliver" = release the completion-unverified hold and type the ping; "wait" = keep queued; "not-held" = normal path. */
export const seatDoneHeldDecision = (f: SeatDoneFacts): "deliver" | "wait" | "not-held" => {
  if (f.provider !== "codex" || f.agentState !== "held") return "not-held";
  if (!f.unqualified || f.holdReason !== "completion-unverified" || f.timedOut) return "wait";
  if (f.logState !== "idle" || f.lastEvent !== "task_complete" || f.lastCompleteAtMs === null) return "wait";
  if (f.nowMs - f.lastCompleteAtMs < f.settleMs) return "wait";
  if (f.heldActivity || f.pendingInput) return "wait";
  if (f.lastInputAtMs !== null && f.nowMs - f.lastInputAtMs < SEAT_DONE_RECENT_INPUT_MS) return "wait";
  return "deliver";
};
// P39c-wired:/** Codex rollout: start/complete times of the last turn. */
/** P39c: staleness from log turn times ONLY (codex or claude). logState ignored; missing logState = unknown = use the times. */
export const isSeatDoneStaleByTimes = (f: Pick<SeatDoneFacts, "lastTurnStartedAtMs" | "lastCompleteAtMs">, queuedAtMs: number): boolean =>
  Number.isFinite(queuedAtMs) && f.lastTurnStartedAtMs !== null && f.lastCompleteAtMs !== null &&
  f.lastTurnStartedAtMs > queuedAtMs && f.lastCompleteAtMs >= f.lastTurnStartedAtMs;
/** P39c: which pending SEAT DONE pings to supersede, on any delivery path (held, idle, post-resume). */
export const seatDonePingsToSupersede = <M extends { messageId: string; content: string; timestamp: string }>(pending: M[], f: Pick<SeatDoneFacts, "lastTurnStartedAtMs" | "lastCompleteAtMs"> | null): M[] =>
  f ? pending.filter((m) => isSeatDonePing(m.content) && isSeatDoneStaleByTimes(f, Date.parse(m.timestamp))) : [];
/** P39c: Claude transcript turn times: real user prompt = start, assistant end_turn = complete. */
export const claudeLastTurnTimes = (tail: string | null): { startedAtMs: number | null; completedAtMs: number | null } => {
  let startedAtMs: number | null = null; let completedAtMs: number | null = null;
  if (!tail) return { startedAtMs, completedAtMs };
  for (const l of tail.split(/\r?\n/)) {
    let r: any; try { r = JSON.parse(l); } catch { continue; }
    const at = r?.timestamp ? Date.parse(r.timestamp) : Number.NaN; if (!Number.isFinite(at)) continue;
    if (r.type === "user") {
      if (r.isCompactSummary || r.isMeta || r.isVisibleInTranscriptOnly) continue;
      const c = r.message?.content; if (Array.isArray(c) && c.length > 0 && c.every((x: any) => x?.type === "tool_result")) continue;
      startedAtMs = at; completedAtMs = null;
    } else if (r.type === "assistant" && r.message?.stop_reason === "end_turn") completedAtMs = at;
  }
  return { startedAtMs, completedAtMs };
};
/** Codex rollout: start/complete times of the last turn. */
export const codexLastTurnTimes = (tail: string | null): { startedAtMs: number | null; completedAtMs: number | null } => {
  let startedAtMs: number | null = null; let completedAtMs: number | null = null;
  if (!tail) return { startedAtMs, completedAtMs };
  for (const l of tail.split(/\r?\n/)) {
    if (!l.includes("event_msg")) continue; let r: any; try { r = JSON.parse(l); } catch { continue; }
    const t = r?.payload?.type; const at = r?.timestamp ? Date.parse(r.timestamp) : Number.NaN; if (!Number.isFinite(at)) continue;
    if (t === "task_started") { startedAtMs = at; completedAtMs = null; } else if (t === "task_complete" || t === "turn_aborted") completedAtMs = at;
  }
  return { startedAtMs, completedAtMs };
};