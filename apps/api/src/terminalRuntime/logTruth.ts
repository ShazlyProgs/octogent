// P27 v2: seat status from session-log truth. Active only when OCTO_LOG_TRUTH=1.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type LogTruthState = "working" | "idle" | "unknown";
export type StateSource = "log" | "notify" | "pty";
export interface LogTruth { state: LogTruthState; event: string | null; eventAt: string | null; turnId: string | null; }

export const isLogTruthEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OCTO_LOG_TRUTH === "1";
export const logTruthMode = (env: NodeJS.ProcessEnv = process.env): "off" | "shadow" | "gate" =>
  !isLogTruthEnabled(env) ? "off" : env.OCTO_LOG_TRUTH_GATE === "1" ? "gate" : "shadow";

/** Read the last maxBytes of a file by content (never by mtime). */
export const readTail = (path: string, maxBytes = 512 * 1024): string | null => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return size > len ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
};

/** P31b: Codex turn marker scan. Reads backwards in chunks (never the whole file) until the
 *  latest turn event line is found; returns just that line. Null (= unknown) at the cap. */
const CODEX_TURN_MARKER = /"type":"event_msg".*"payload":\{"type":"(task_started|user_message|task_complete|turn_aborted)"/;
export const readCodexTurnTail = (path: string, chunkBytes = 512 * 1024, capBytes = 32 * 1024 * 1024): string | null => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let scanned = 0;
    while (pos > 0 && scanned < capBytes) {
      const len = Math.min(chunkBytes, pos, capBytes - scanned);
      pos -= len;
      scanned += len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const joined = carry.length ? Buffer.concat([buf, carry]) : buf;
      const text = joined.toString("utf8");
      const lines = text.split(/\r?\n/);
      const firstComplete = pos === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= firstComplete; i--) {
        const line = lines[i] ?? "";
        if (line && CODEX_TURN_MARKER.test(line)) return line;
      }
      carry = pos === 0 ? Buffer.alloc(0) : Buffer.from(lines[0] ?? "", "utf8");
      if (carry.length > capBytes) return null;
    }
    return pos === 0 ? "" : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
};

const parseLines = (tail: string): any[] =>
  tail.split(/\r?\n/).flatMap((l) => { if (!l.trim()) return []; try { return [JSON.parse(l)]; } catch { return []; } });

/** Codex rollout: last turn event wins. Compaction and other items do not change state. */
export const deriveCodexTruth = (tail: string | null): LogTruth => {
  if (tail === null) return { state: "unknown", event: null, eventAt: null, turnId: null };
  let out: LogTruth = { state: "unknown", event: null, eventAt: null, turnId: null };
  for (const rec of parseLines(tail)) {
    const t = rec?.type === "event_msg" ? rec?.payload?.type : undefined;
    if (!t) continue;
    const turnId = rec.payload.turn_id ?? rec.payload.root_turn_id ?? rec.payload.turn_attribution?.turn_id ?? null;
    if (t === "task_started" || t === "user_message") out = { state: "working", event: t, eventAt: rec.timestamp ?? null, turnId };
    else if (t === "task_complete" || t === "turn_aborted") out = { state: "idle", event: t, eventAt: rec.timestamp ?? null, turnId };
  }
  return out;
};

/** P40: broadcast log-truth display changes to the UI (OCTO_UI_STATUS_FIX=1). */
export const isUiStatusFixEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OCTO_UI_STATUS_FIX === "1";
/** P38: skip Claude's synthetic user records (compaction summary, meta, transcript-only) when OCTO_CLAUDE_SYNTHETIC_SKIP=1. */
export const isClaudeSyntheticSkipEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OCTO_CLAUDE_SYNTHETIC_SKIP === "1";
export const isClaudeSyntheticUser = (rec: any): boolean => !!(rec?.isCompactSummary || rec?.isMeta || rec?.isVisibleInTranscriptOnly);
/** P38: seat liveness (OCTO_SEAT_LIVENESS=1, _MS default 300000) for ALL seats. */
export const isSeatLivenessEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OCTO_SEAT_LIVENESS === "1";
export const seatLivenessMs = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env.OCTO_SEAT_LIVENESS_MS); return Number.isFinite(n) && n > 0 ? n : 300_000; };
/** "stuck" when the display says processing but neither the session log nor the PTY moved for thresholdMs. */
export const livenessVerdict = (i: { display: string; logMtimeMs: number | null; eventAtMs: number | null; ptyQuietMs: number; nowMs: number; thresholdMs: number }): "ok" | "stuck" => {
  if (i.display !== "processing") return "ok";
  const lastLog = Math.max(i.logMtimeMs ?? 0, i.eventAtMs ?? 0);
  if (!lastLog) return "ok";
  return i.nowMs - lastLog >= i.thresholdMs && i.ptyQuietMs >= i.thresholdMs ? "stuck" : "ok";
};
/** P38/P37: last real Claude prompt text (for the resend flag), max 200 chars. */
export const lastClaudePrompt = (tail: string | null): string | null => {
  if (!tail) return null; let out: string | null = null;
  for (const rec of parseLines(tail)) {
    if (rec?.type === "last-prompt" && typeof rec.lastPrompt === "string") out = rec.lastPrompt;
    else if (rec?.type === "user" && !isClaudeSyntheticUser(rec)) { const c = rec.message?.content; if (typeof c === "string") out = c; else if (Array.isArray(c)) { const t = c.find((x: any) => x?.type === "text"); if (t?.text) out = t.text; } }
  }
  return out ? out.slice(0, 200) : null;
};

/** Claude transcript: last real user prompt vs assistant end_turn stop. */
export const deriveClaudeTruth = (tail: string | null, skipSynthetic: boolean = isClaudeSyntheticSkipEnabled()): LogTruth => {
  if (tail === null) return { state: "unknown", event: null, eventAt: null, turnId: null };
  let out: LogTruth = { state: "unknown", event: null, eventAt: null, turnId: null };
  for (const rec of parseLines(tail)) {
    if (rec?.type === "user") {
      const c = rec.message?.content;
      const isToolResult = Array.isArray(c) && c.length > 0 && c.every((x: any) => x?.type === "tool_result");
      if (!isToolResult && !(skipSynthetic && isClaudeSyntheticUser(rec))) out = { state: "working", event: "user", eventAt: rec.timestamp ?? null, turnId: rec.uuid ?? null };
    } else if (rec?.type === "assistant" && rec.message?.stop_reason === "end_turn") {
      out = { state: "idle", event: "end_turn", eventAt: rec.timestamp ?? null, turnId: rec.uuid ?? null };
    }
  }
  return out;
};

export interface SeatLatch {
  turnId: string | null; submittedAt: string | null; timedOut: boolean;
  unqualifiedReason: string | null; // hold reason, if held
}
export type LogTruthAction =
  | { kind: "none" }
  | { kind: "resolve-turn"; log: string }
  | { kind: "unhold"; state: "processing" | "idle"; log: string };

export const RELEASABLE_HOLD_REASON = "completion-unverified";

/** Decide what the reconciler may do. Only completion-unverified holds are ever released. */
export const decideLogTruthAction = (latch: SeatLatch, truth: LogTruth): LogTruthAction => {
  if (latch.unqualifiedReason !== null) {
    if (latch.unqualifiedReason !== RELEASABLE_HOLD_REASON || truth.state === "unknown") return { kind: "none" };
    return { kind: "unhold", state: truth.state === "working" ? "processing" : "idle",
      log: `log-truth-unhold reason=${latch.unqualifiedReason} event=${truth.event}@${truth.eventAt}` };
  }
  if (latch.turnId && truth.state === "idle") {
    const after = !latch.submittedAt || !truth.eventAt || Date.parse(truth.eventAt) >= Date.parse(latch.submittedAt);
    if (after) return { kind: "resolve-turn", log: `log-truth-resolve turnId=${latch.turnId} event=${truth.event}@${truth.eventAt}` };
  }
  return { kind: "none" };
};

/** Notify acceptance: match on turnId even if processGeneration/revision moved (flag on). */
export const notifyMatches = (latched: { turnId: string; generation: number }, notify: { turnId: string; generation: number },
  env: NodeJS.ProcessEnv = process.env): boolean =>
  latched.turnId === notify.turnId && (latched.generation === notify.generation || isLogTruthEnabled(env));

/** Display state: timeout or no readable log is "unknown", never "processing". */
export const displayState = (legacy: string, latch: SeatLatch, truth: LogTruth, nowMs: number, ptyQuietMs: number):
  { state: string; stateSource: StateSource; stateAgeSec: number | null } => {
  const age = truth.eventAt ? Math.max(0, Math.round((nowMs - Date.parse(truth.eventAt)) / 1000)) : null;
  if (truth.state !== "unknown") return { state: truth.state === "working" ? "processing" : "idle", stateSource: "log", stateAgeSec: age };
  if (latch.timedOut) return { state: "unknown", stateSource: "notify", stateAgeSec: age };
  if (ptyQuietMs >= 120_000) return { state: "unknown", stateSource: "pty", stateAgeSec: Math.round(ptyQuietMs / 1000) };
  return { state: legacy, stateSource: "pty", stateAgeSec: Math.round(ptyQuietMs / 1000) };
};

/** Gate: unknown is not deliverable but not busy; caller reports "check log". */
export const gateVerdict = (s: string): "deliverable" | "busy" | "check-log" =>
  s === "idle" ? "deliverable" : s === "unknown" ? "check-log" : "busy";


/** P32: latch reconciliation (OCTO_LATCH_RECONCILE=1). A Codex seat latched "processing" by a
 *  delivery is cleared only when the rollout's latest turn marker is a completion OLDER than the
 *  delivery (no task_started/user_message since), for at least OCTO_LATCH_RECONCILE_MS (default
 *  3 min). Working or unknown never clears, so an open turn is never cut. */
export const isLatchReconcileEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OCTO_LATCH_RECONCILE === "1";
export const latchReconcileMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number.parseInt(env.OCTO_LATCH_RECONCILE_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
};
export const shouldReconcileLatch = (input: {
  turnId: string | null | undefined; submittedAtMs: number | undefined; legacy: string;
  truth: LogTruth; nowMs: number; thresholdMs: number;
  /** P42: session start; completions before this are from a prior session and must not latch. */
  startedAtMs?: number | null;
}): boolean => {
  const { turnId, submittedAtMs, legacy, truth, nowMs, thresholdMs, startedAtMs } = input;
  if (!turnId || submittedAtMs === undefined || legacy !== "processing") return false;
  if (nowMs - submittedAtMs < thresholdMs) return false;
  if (truth.state !== "idle") return false; // working (open turn) or unknown: never clear
  if (!truth.eventAt) return false;
  const eventMs = Date.parse(truth.eventAt);
  if (!Number.isFinite(eventMs) || eventMs >= submittedAtMs) return false;
  // P42-wired: ignore prior-session completions (eventAt < startedAt).
  if (startedAtMs != null && Number.isFinite(startedAtMs) && eventMs < startedAtMs) return false;
  return true;
};


export const isPostResumeReconcileEnabled = (): boolean => process.env.OCTO_POST_RESUME_RECONCILE === "1";
export const postResumeReconcileMs = (): number => { const n = Number(process.env.OCTO_POST_RESUME_RECONCILE_MS); return Number.isFinite(n) && n > 0 ? n : 60_000; };
/** P32b: completed-but-unacknowledged latch (OCTO_LATCH_COMPLETE_RECONCILE=1, _MS default 120000). */
export const isLatchCompleteReconcileEnabled = (): boolean => process.env.OCTO_LATCH_COMPLETE_RECONCILE === "1";
export const latchCompleteReconcileMs = (): number => { const n = Number(process.env.OCTO_LATCH_COMPLETE_RECONCILE_MS); return Number.isFinite(n) && n > 0 ? n : 120_000; };
/** P33: Enter retry (OCTO_ENTER_RETRY=1, OCTO_ENTER_RETRY_MS default 20000). */
export const isEnterRetryEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OCTO_ENTER_RETRY === "1";
export const enterRetryMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number.parseInt(env.OCTO_ENTER_RETRY_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
};
/** true = the agent's log shows turn activity at/after sinceMs; false = none; null = log unreadable (skip). */
export const p33TurnStartedSince = (provider: "codex" | "claude", tail: string | null, sinceMs: number): boolean | null => {
  if (tail === null) return null;
  for (const line of tail.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    let rec: any; try { rec = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(rec?.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;
    if (ts < sinceMs - 2000) return false; // older than the delivery: nothing newer was found
    if (provider === "codex") {
      if (rec.type === "event_msg" && ["task_started", "user_message", "task_complete", "turn_aborted"].includes(rec.payload?.type)) return true;
    } else if (rec.type === "user" || rec.type === "assistant") return true;
  }
  return false;
};
/** Compare with all whitespace and ANSI removed: Codex re-renders pasted text without spaces. */
const squash = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+/g, "");
// P33b: accumulate a typed (ws-input) burst. Returns the printable text submitted when a \r arrives.
export const p33bTypedStep = (buf: string, data: string): { buf: string; submit?: string } => {
  const clean = data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "").replace(/\x1b./g, "");
  let b = buf;
  for (const ch of clean) {
    if (ch === "\r") return { buf: "", submit: b };
    if (ch === "\x7f" || ch === "\b") { b = b.slice(0, -1); continue; }
    if (ch === "\n" || ch === "\t") { b += " "; continue; }
    if (ch >= " ") b += ch;
  }
  return { buf: b.slice(-4096) };
};
export const P33B_MIN_CHARS = 20;
export const P33B_BURST_MS = 10_000;
export const isEnterRetryTypedEnabled = (): boolean => process.env.OCTO_ENTER_RETRY === "1" && process.env.OCTO_ENTER_RETRY_TYPED !== "0";
export const p33VisibleAtPrompt = (screenTail: string, text: string, turnId?: string): boolean => {
  const screen = squash(screenTail);
  if (turnId && screen.includes(turnId)) return true;
  const probe = squash(text).slice(0, 48);
  return probe.length >= 8 && screen.includes(probe);
};
