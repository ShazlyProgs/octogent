import { randomUUID } from "node:crypto";
import { type WriteStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import * as p27fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import * as p27os from "node:os";
import * as p27path from "node:path";
import type { Duplex } from "node:stream";

import { type IPty, spawn } from "node-pty";
import type { WebSocket, WebSocketServer } from "ws";

import { type AgentRuntimeState, AgentStateTracker } from "../agentStateDetection";
import {
  type SeatDoneFacts,
  claudeLastTurnTimes,
  codexLastTurnTimes,
  completionSettleWaiterMs,
} from "./completionNotify";
import {
  type LogTruth,
  P33B_BURST_MS,
  P33B_MIN_CHARS,
  decideLogTruthAction,
  deriveClaudeTruth,
  deriveCodexTruth,
  displayState,
  enterRetryMs,
  isEnterRetryEnabled,
  isEnterRetryTypedEnabled,
  isLatchCompleteReconcileEnabled,
  isLatchReconcileEnabled,
  isLogTruthEnabled,
  isPostResumeReconcileEnabled,
  isSeatLivenessEnabled,
  isUiStatusFixEnabled,
  lastClaudePrompt,
  latchCompleteReconcileMs,
  latchReconcileMs,
  livenessVerdict,
  logTruthMode,
  p33TurnStartedSince,
  p33VisibleAtPrompt,
  p33bTypedStep,
  postResumeReconcileMs,
  readCodexTurnTail,
  readTail,
  seatLivenessMs,
  shouldReconcileLatch,
} from "./logTruth";
import type { ProcessIdentity } from "./providerPresence";
import {
  DEFAULT_AGENT_PROVIDER,
  TERMINAL_BOOTSTRAP_COMMANDS,
  TERMINAL_SCROLLBACK_MAX_BYTES,
  TERMINAL_SESSION_IDLE_GRACE_MS,
} from "./constants";
import {
  type ConversationTranscriptEvent,
  type ConversationTranscriptEventPayload,
  ensureTranscriptDirectory,
  transcriptFilenameForSession,
} from "./conversations";
import { broadcastMessage, getTerminalId, sendMessage } from "./protocol";
import { createShellEnvironment, ensureNodePtySpawnHelperExecutable } from "./ptyEnvironment";
import { toErrorMessage } from "./systemClients";
import type {
  DirectSessionListener,
  PersistedTerminal,
  TerminalAgentProvider,
  TerminalSession,
} from "./types";

type CreateSessionRuntimeOptions = {
  websocketServer: WebSocketServer;
  terminals: Map<string, PersistedTerminal>;
  sessions: Map<string, TerminalSession>;
  resolveTerminalSession?: (terminalId: string) => {
    sessionId: string;
    tentacleId: string;
  } | null;
  getTentacleWorkspaceCwd: (tentacleId: string) => string;
  isDebugPtyLogsEnabled: boolean;
  ptyLogDir: string;
  transcriptDirectoryPath: string;
  sessionIdleGraceMs?: number;
  scrollbackMaxBytes?: number;
  onStateChange?: (terminalId: string, state: AgentRuntimeState, toolName?: string) => void;
  onAgentProviderChange?: (sessionId: string, provider: TerminalAgentProvider | undefined) => void;
  onHeldActivityChange?: (sessionId: string) => void;
  codexTurnWatchdogMs?: number;
  readProcessIdentities?: () => Promise<ProcessIdentity[]>;
  onEnterRetryEvent?: (details: {
    type: "enter_retry" | "delivery_blocked";
    terminalId: string;
    provider: string;
    deliveredAt: string;
    at: string;
    reason?: string;
    source?: "channel" | "typed";
    probe?: string;
  }) => void;
  onLatchReconciled?: (details: {
    terminalId: string;
    turnId: string;
    submittedAt: string;
    event: string | null;
    eventAt: string | null;
    kind?: "post_resume" | "completed_unacknowledged";
    processingSince?: string;
  }) => void;
  onLogTruth?: (terminalId: string, truth: { state: string; event: string | null; eventAt: string | null }) => void;
  onSeatLiveness?: (details: {
    terminalId: string;
    provider: string;
    kind: "lost_submit" | "stale_processing";
    processingSince: string | null;
    logLastWriteAt: string | null;
    event: string | null;
    pendingDelivery: string | null;
    resendSuggested: boolean;
  }) => void;
};

const ANSI_BEL = String.fromCharCode(0x07);
const ANSI_ESCAPE = String.fromCharCode(0x1b);
const BROKEN_OSC_TAIL_RE = new RegExp(
  `^\\][^${ANSI_BEL}${ANSI_ESCAPE}]*(?:${ANSI_BEL}|${ANSI_ESCAPE}\\\\)`,
);


export const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Typed into the seat PTY (already in the seat cwd). Id is validated, so no quoting is needed. */
export const buildClaudeResumeCommand = (base: string, sessionId: string): string => {
  if (!CLAUDE_SESSION_ID_PATTERN.test(sessionId)) throw new Error("invalid Claude session id");
  return `${base} --resume ${sessionId}`;
};

export const createSessionRuntime = ({
  websocketServer,
  terminals,
  sessions,
  resolveTerminalSession,
  getTentacleWorkspaceCwd,
  isDebugPtyLogsEnabled,
  ptyLogDir,
  transcriptDirectoryPath,
  sessionIdleGraceMs = TERMINAL_SESSION_IDLE_GRACE_MS,
  scrollbackMaxBytes = TERMINAL_SCROLLBACK_MAX_BYTES,
  onStateChange,
  onHeldActivityChange,
  codexTurnWatchdogMs = 0,
  readProcessIdentities,
  onEnterRetryEvent,
  onLatchReconciled,
  onLogTruth,
  onSeatLiveness,
}: CreateSessionRuntimeOptions) => {
  const DEFAULT_PTY_COLS = 120;
  const DEFAULT_PTY_ROWS = 35;

  const getShellLaunch = () => {
    if (process.platform === "win32") {
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: [],
      };
    }

    const shellFromEnvironment = process.env.SHELL?.trim();
    if (shellFromEnvironment && shellFromEnvironment.length > 0) {
      return {
        command: shellFromEnvironment,
        args: ["-i"],
      };
    }

    return {
      command: "/bin/bash",
      args: ["-i"],
    };
  };

  const createDebugLog = (sessionId: string) => {
    if (!isDebugPtyLogsEnabled) {
      return undefined;
    }

    mkdirSync(ptyLogDir, { recursive: true });
    const filename = `${sessionId}-${Date.now()}.log`;
    return createWriteStream(join(ptyLogDir, filename), {
      flags: "a",
      encoding: "utf8",
    });
  };

  const appendDebugLog = (session: TerminalSession, line: string) => {
    session.debugLog?.write(`${new Date().toISOString()} ${line}\n`);
  };

  const createTranscriptLog = (sessionId: string) => {
    ensureTranscriptDirectory(transcriptDirectoryPath);
    const filename = transcriptFilenameForSession(sessionId);
    const stream = createWriteStream(join(transcriptDirectoryPath, filename), {
      flags: "a",
      encoding: "utf8",
    });
    stream.on("error", () => {
      // Keep terminal flow alive even if transcript writes fail.
    });
    return stream;
  };

  const appendTranscriptEvent = (
    session: TerminalSession,
    sessionId: string,
    event: ConversationTranscriptEventPayload,
  ) => {
    if (!session.transcriptLog) {
      return;
    }

    const nextEventCount = (session.transcriptEventCount ?? 0) + 1;
    session.transcriptEventCount = nextEventCount;
    const payload: ConversationTranscriptEvent = {
      ...event,
      eventId: `${sessionId}:${nextEventCount}`,
      sessionId,
      tentacleId: session.tentacleId,
    } as ConversationTranscriptEvent;
    session.transcriptLog.write(`${JSON.stringify(payload)}\n`);
  };

  const closeTranscript = (
    session: TerminalSession,
    sessionId: string,
    event: ConversationTranscriptEventPayload,
  ) => {
    if (session.hasTranscriptEnded) {
      return;
    }

    appendTranscriptEvent(session, sessionId, event);
    session.hasTranscriptEnded = true;
    session.transcriptLog?.end();
    session.transcriptLog = undefined;
  };


  type CodexWatchdog = {
    timer?: ReturnType<typeof setTimeout> | undefined;
    turnId?: string | undefined;
    processGeneration: number;
    submitted: boolean;
    timedOut: boolean;
    unqualified: boolean;
    holdReason?: string | undefined;
    revision: number;
  };
  const codexWatchdogs = new WeakMap<TerminalSession, CodexWatchdog>();
  const composerTimers = new WeakMap<TerminalSession, Set<ReturnType<typeof setTimeout>>>();
  const detectedProviders = new Map<string, TerminalAgentProvider>();
  const getCodexWatchdog = (session: TerminalSession): CodexWatchdog => {
    let watchdog = codexWatchdogs.get(session);
    if (!watchdog) {
      watchdog = { processGeneration: 1, submitted: false, timedOut: false, unqualified: false, revision: 0 };
      codexWatchdogs.set(session, watchdog);
    }
    return watchdog;
  };
  const clearCodexTurnWatchdog = (session: TerminalSession) => {
    const watchdog = getCodexWatchdog(session);
    if (watchdog.timer) clearTimeout(watchdog.timer);
    watchdog.timer = undefined;
    watchdog.turnId = undefined;
    watchdog.submitted = false;
    watchdog.timedOut = false;
    watchdog.unqualified = false;
    watchdog.holdReason = undefined;
  };
  const isSessionActive = (terminalId: string, session: TerminalSession) => sessions.get(terminalId) === session;
  const getEffectiveAgentProvider = (terminalId: string): TerminalAgentProvider | undefined =>
    detectedProviders.get(terminalId) ??
    sessions.get(terminalId)?.agentProviderOverride ??
    terminals.get(terminalId)?.agentProvider;
  const getHeldActivity = (_terminalId: string) => false;
  const writeOwnedPrompt = (_terminalId: string, session: TerminalSession, data: string) => {
    session.pty.write(data);
    return true;
  };
  const trackComposerTimer = (session: TerminalSession, timer: ReturnType<typeof setTimeout>) => {
    const timers = composerTimers.get(session) ?? new Set<ReturnType<typeof setTimeout>>();
    timers.add(timer);
    composerTimers.set(session, timers);
  };
  const clearComposerTimers = (session: TerminalSession) => {
    const timers = composerTimers.get(session);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  // P27 log truth (OCTO_LOG_TRUTH=1; shadow unless OCTO_LOG_TRUTH_GATE=1). Old path untouched when off.
  type P27Entry = { at: number; truth: LogTruth; display: ReturnType<typeof displayState>; legacy: string };
  const p27State = new Map<string, P27Entry>();
  const p27PathCache = new Map<string, { path: string | null; at: number }>();
  const p27SubmitAt = new WeakMap<TerminalSession, number>();
  const p27FindFile = (dir: string, needle: string, depth: number): string | null => {
    let entries: p27fs.Dirent[];
    try { entries = p27fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) if (e.isFile() && e.name.endsWith(".jsonl") && e.name.includes(needle)) return p27path.join(dir, e.name);
    if (depth <= 0) return null;
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const hit = p27FindFile(p27path.join(dir, e.name), needle, depth - 1);
      if (hit) return hit;
    }
    return null;
  };
  const p27LogPath = (sessionId: string, session: TerminalSession): { provider: "codex" | "claude" | null; path: string | null } => {
    const effective = getEffectiveAgentProvider(sessionId);
    const term = terminals.get(sessionId);
    const provider = effective === "codex" ? "codex" : effective === "claude-code" ? "claude" : null;
    if (!provider) return { provider: null, path: null };
    const id = provider === "codex" ? (session.codexProviderThreadId ?? session.codexResumeThreadId ?? term?.codexThreadId) : term?.claudeSessionId;
    if (!id) return { provider, path: null };
    const cached = p27PathCache.get(id);
    if (cached && (cached.path || Date.now() - cached.at < 60_000)) return { provider, path: cached.path };
    const base = provider === "codex" ? p27path.join(p27os.homedir(), ".codex", "sessions") : p27path.join(p27os.homedir(), ".claude", "projects");
    const found = p27FindFile(base, id, provider === "codex" ? 3 : 1);
    p27PathCache.set(id, { path: found, at: Date.now() });
    return { provider, path: found };
  };
  const p27Reconcile = (session: TerminalSession, sessionId: string) => {
    if (!isLogTruthEnabled() || !isSessionActive(sessionId, session)) return;
    const now = Date.now();
    const prev = p27State.get(sessionId);
    if (prev && now - prev.at < 10_000) return;
    const { provider, path: logPath } = p27LogPath(sessionId, session);
    if (!provider) return;
    const tail = logPath ? (provider === "codex" ? readCodexTurnTail(logPath) : readTail(logPath)) : null;
    const truth = provider === "codex" ? deriveCodexTruth(tail) : deriveClaudeTruth(tail);
    try { onLogTruth?.(sessionId, truth); } catch { /* P39 never breaks the poll */ }
    const w = getCodexWatchdog(session);
    const submitAt = p27SubmitAt.get(session);
    const latch = {
      turnId: w.turnId ?? null,
      submittedAt: submitAt ? new Date(submitAt).toISOString() : null,
      timedOut: w.timedOut,
      unqualifiedReason: w.unqualified ? (w.holdReason ?? "unspecified") : null,
    };
    const legacy: string = session.claudeTurnPending ? "processing" : session.agentState;
    let display = displayState(legacy, latch, truth, now, now - (session.lastPtyOutputAt ?? now));
    // P38: liveness for all seats. Display only (+ journal once per stuck event); never types, never restarts.
    if (isSeatLivenessEnabled()) {
      try {
        let mtime: number | null = null; try { mtime = logPath ? p27fs.statSync(logPath).mtimeMs : null; } catch { mtime = null; }
        const evMs = truth.eventAt ? Date.parse(truth.eventAt) : null;
        const v = livenessVerdict({ display: display.state, logMtimeMs: mtime, eventAtMs: Number.isFinite(evMs as number) ? evMs : null, ptyQuietMs: now - (session.lastPtyOutputAt ?? 0), nowMs: now, thresholdMs: seatLivenessMs() });
        if (v === "stuck") {
          display = { ...display, state: "stuck" };
          const key = `${truth.eventAt}|${truth.turnId}`;
          if (p38Logged.get(sessionId) !== key) {
            p38Logged.set(sessionId, key);
            const lostSubmit = truth.event === "user" || truth.event === "user_message";
            const pendingDelivery = provider !== "codex" ? lastClaudePrompt(tail) : null;
            appendDebugLog(session, `seat-liveness-stuck session=${sessionId} provider=${provider} event=${truth.event}@${truth.eventAt}`);
            try { onSeatLiveness?.({ terminalId: sessionId, provider: String(provider), kind: lostSubmit ? "lost_submit" : "stale_processing", processingSince: truth.eventAt ?? null, logLastWriteAt: mtime ? new Date(mtime).toISOString() : null, event: truth.event ?? null, pendingDelivery, resendSuggested: lostSubmit }); } catch { /* journal only */ }
          }
        } else p38Logged.delete(sessionId);
      } catch { /* never break the poll */ }
    }
    const changed = !prev || prev.display.state !== display.state || prev.legacy !== legacy;
    p27State.set(sessionId, { at: now, truth, display, legacy });
    if (changed && isUiStatusFixEnabled()) { try { onHeldActivityChange?.(sessionId); } catch { /* P40 push only */ } }
    if (changed) appendDebugLog(session, `log-truth-${logTruthMode()} session=${sessionId} legacy=${legacy} derived=${display.state} source=${display.stateSource} age=${display.stateAgeSec} event=${truth.event}@${truth.eventAt}`);
    if (provider === "codex" && reconcileLatch(sessionId, truth, now)) return;
    if (logTruthMode() !== "gate" || provider !== "codex") return;
    const action = decideLogTruthAction(latch, truth);
    if (action.kind === "none") return;
    appendDebugLog(session, action.log);
    clearCodexTurnWatchdog(session);
    emitStateIfChanged(session, sessionId, action.kind === "unhold" ? action.state : "idle");
  };
  const p34Since = new WeakMap<TerminalSession, number>();
  const p38Logged = new Map<string, string>();
  const p32bSince = new WeakMap<TerminalSession, number>();
  /** P32: clear a delivery latch that never reached the rollout. Returns true if cleared. */
  const reconcileLatch = (terminalId: string, truth: ReturnType<typeof deriveCodexTruth>, now = Date.now()): boolean => {
    if (!isLatchReconcileEnabled()) return false;
    const session = sessions.get(terminalId);
    if (!session || !isSessionActive(terminalId, session)) return false;
    if (getEffectiveAgentProvider(terminalId) !== "codex") return false;
    const w = getCodexWatchdog(session);
    const submitAt = p27SubmitAt.get(session);
    // P34: 'processing' with no delivery since the resume (no submit, no turn id) while the log shows a completed turn.
    if (submitAt === undefined && !w.turnId) {
      const ok = isPostResumeReconcileEnabled() && session.agentState === "processing" && truth.state === "idle" && !!truth.eventAt
        && (truth.event === "task_complete" || truth.event === "turn_aborted");
      if (!ok) { p34Since.delete(session); return false; }
      const since = p34Since.get(session) ?? now; p34Since.set(session, since);
      if (now - since < postResumeReconcileMs()) return false;
      p34Since.delete(session);
      const processingSince = new Date(since).toISOString();
      appendDebugLog(session, `latch-reconcile-post-resume session=${terminalId} processingSince=${processingSince} event=${truth.event}@${truth.eventAt}`);
      clearCodexTurnWatchdog(session);
      session.stateTracker.forceState("idle");
      emitStateIfChanged(session, terminalId, "idle");
      try { onLatchReconciled?.({ terminalId, turnId: "none", submittedAt: "", event: truth.event ?? null, eventAt: truth.eventAt ?? null, kind: "post_resume", processingSince }); } catch { /* never break the poll */ }
      return true;
    }
    p34Since.delete(session);
    // P32b: delivered, the log shows a completion NEWER than the delivery (so no newer start), but the legacy latch never saw it.
    if (submitAt !== undefined) {
      const evMs = truth.eventAt ? Date.parse(truth.eventAt) : Number.NaN;
      const ok = isLatchCompleteReconcileEnabled() && session.agentState === "processing" && truth.state === "idle"
        && (truth.event === "task_complete" || truth.event === "turn_aborted") && Number.isFinite(evMs) && evMs > submitAt;
      if (!ok) p32bSince.delete(session);
      else {
        const since = p32bSince.get(session) ?? now; p32bSince.set(session, since);
        if (now - since >= latchCompleteReconcileMs()) {
          p32bSince.delete(session);
          const submittedAt = new Date(submitAt).toISOString(); const turnId = w.turnId ?? "none";
          appendDebugLog(session, `latch-reconcile-completed-unacknowledged session=${terminalId} submittedAt=${submittedAt} event=${truth.event}@${truth.eventAt}`);
          clearCodexTurnWatchdog(session);
          p27SubmitAt.delete(session);
          session.stateTracker.forceState("idle");
          emitStateIfChanged(session, terminalId, "idle");
          try { onLatchReconciled?.({ terminalId, turnId, submittedAt, event: truth.event ?? null, eventAt: truth.eventAt ?? null, kind: "completed_unacknowledged", processingSince: new Date(since).toISOString() }); } catch { /* never break the poll */ }
          return true;
        }
      }
    }
    if (w.unqualified || w.timedOut) return false;
    const startedAtMs = (() => { const t = terminals.get(terminalId); const raw = t?.startedAt; const n = raw ? Date.parse(raw) : Number.NaN; return Number.isFinite(n) ? n : null; })();
    // P42-wired: pass session startedAt so stale prior-session completions cannot latch
    if (!shouldReconcileLatch({ turnId: w.turnId, submittedAtMs: submitAt, legacy: session.agentState, truth, nowMs: now, thresholdMs: latchReconcileMs(), startedAtMs })) return false;
    const turnId = w.turnId as string;
    const submittedAt = new Date(submitAt as number).toISOString();
    appendDebugLog(session, `latch-reconcile session=${terminalId} turnId=${turnId} submittedAt=${submittedAt} delivery=not-submitted event=${truth.event}@${truth.eventAt}`);
    clearCodexTurnWatchdog(session);
    p27SubmitAt.delete(session);
    session.stateTracker.forceState("idle");
    emitStateIfChanged(session, terminalId, "idle");
    try { onLatchReconciled?.({ terminalId, turnId, submittedAt, event: truth.event ?? null, eventAt: truth.eventAt ?? null }); } catch { /* never break the poll */ }
    return true;
  };

  /** P33: one extra Enter when the delivery never reached the agent log; block if that fails too. */
  const p33Started = (terminalId: string, session: TerminalSession, sinceMs: number): { provider: string; started: boolean | null } => {
    const { provider, path } = p27LogPath(terminalId, session);
    if (!provider || !path) return { provider: provider ?? "unknown", started: null };
    const tail = readTail(path);
    return { provider, started: p33TurnStartedSince(provider, tail, sinceMs) };
  };
  const p33ScreenTail = (session: TerminalSession): string => (session.scrollbackChunks ?? []).join("").slice(-8192);
  const scheduleEnterRetry = (terminalId: string, session: TerminalSession) => {
    const pending = session.p33Pending;
    if (!isEnterRetryEnabled() || !pending || pending.retried) return;
    if (pending.timer) clearTimeout(pending.timer); // debounce: count from the LAST built-in Enter
    const ms = enterRetryMs();
    const live = () => isSessionActive(terminalId, session) && session.p33Pending === pending;
    const deliveredAt = new Date(pending.at).toISOString();
    pending.timer = setTimeout(() => {
      try {
        if (!live()) return;
        pending.retried = true;
        const first = p33Started(terminalId, session, pending.at);
        if (first.started !== false) { delete session.p33Pending; return; } // started, or log unreadable: never touch
        if (!p33VisibleAtPrompt(p33ScreenTail(session), pending.text, pending.turnId)) { delete session.p33Pending; return; }
        appendDebugLog(session, `p33-enter-retry session=${terminalId} deliveredAt=${deliveredAt}`);
        writeOwnedPrompt(terminalId, session, "\r");
        try { onEnterRetryEvent?.({ type: "enter_retry", terminalId, provider: first.provider, deliveredAt, at: new Date().toISOString(), source: pending.source ?? "channel", ...(pending.source ? { probe: pending.text.slice(-80) } : {}) }); } catch { /* journal only */ }
        setTimeout(() => {
          try {
            if (!live()) return;
            const second = p33Started(terminalId, session, pending.at);
            delete session.p33Pending;
            if (second.started !== false) return;
            const at = new Date().toISOString();
            session.deliveryBlocked = { reason: "dirty_input_needs_clean", at };
            appendDebugLog(session, `p33-delivery-blocked session=${terminalId} reason=dirty_input_needs_clean deliveredAt=${deliveredAt}`);
            try { onEnterRetryEvent?.({ type: "delivery_blocked", terminalId, provider: second.provider, deliveredAt, at, reason: "dirty_input_needs_clean", source: pending.source ?? "channel", ...(pending.source ? { probe: pending.text.slice(-80) } : {}) }); } catch { /* journal only */ }
          } catch { /* never break the runtime */ }
        }, ms);
      } catch { /* never break the runtime */ }
    }, ms);
  };
  // P33b: typed ws-input submissions (Grok injectors) get the same one-Enter retry / block check.
  const p33bObserveTyped = (terminalId: string, session: TerminalSession, data: string) => {
    try {
      if (!isEnterRetryTypedEnabled()) return;
      const now = Date.now();
      const prev = session.p33bTyped && now - session.p33bTyped.at <= P33B_BURST_MS ? session.p33bTyped.text : "";
      const step = p33bTypedStep(prev, data);
      if (step.submit === undefined) { if (step.buf) session.p33bTyped = { at: now, text: step.buf }; else delete session.p33bTyped; return; }
      delete session.p33bTyped;
      const typed = step.submit.trim();
      if (typed.length < P33B_MIN_CHARS || session.p33Pending || session.deliveryBlocked) return; // human keystrokes / already tracked
      session.p33Pending = { at: now, text: typed.slice(-120), source: "typed" };
      appendDebugLog(session, `p33b-typed-submit session=${terminalId} chars=${typed.length}`);
      scheduleEnterRetry(terminalId, session);
    } catch { /* never break the input path */ }
  };
  const observeTypedInput = (terminalId: string, data: string) => { p39bLastInput.set(terminalId, Date.now()); const s = sessions.get(terminalId); if (s) p33bObserveTyped(terminalId, s, data); };
  const getDeliveryBlocked = (terminalId: string) => sessions.get(terminalId)?.deliveryBlocked;

  // P39b: facts for SEAT DONE delivery to a held Codex waiter.
  const p39bLastInput = new Map<string, number>();
  const getSeatDoneFacts = (terminalId: string): SeatDoneFacts | null => {
    const session = sessions.get(terminalId);
    if (!session || !isSessionActive(terminalId, session)) return null;
    const provider = getEffectiveAgentProvider(terminalId) ?? null;
    const w = getCodexWatchdog(session); const e = p27State.get(terminalId);
    let times = { startedAtMs: null as number | null, completedAtMs: null as number | null };
    if (provider === "codex") { const { path: lp } = p27LogPath(terminalId, session); times = codexLastTurnTimes(lp ? readCodexTurnTail(lp) : null); } else if (provider === "claude-code") { /* P39c-wired:claude */ const { path: lp } = p27LogPath(terminalId, session); times = claudeLastTurnTimes(lp ? readTail(lp) : null); }
    return { provider, agentState: session.agentState, unqualified: !!w.unqualified, holdReason: w.holdReason ?? null, timedOut: !!w.timedOut,
      logState: e?.display.state ?? "unknown", lastEvent: e?.truth.event ?? null, lastCompleteAtMs: times.completedAtMs, lastTurnStartedAtMs: times.startedAtMs,
      heldActivity: getHeldActivity(terminalId), pendingInput: !!(session.p33Pending || session.p33bTyped || session.deliveryBlocked || session.pendingComposerSubmit || session.claudeTurnPending),
      lastInputAtMs: p39bLastInput.get(terminalId) ?? null, nowMs: Date.now(), settleMs: completionSettleWaiterMs() };
  };
  const releaseHeldForSeatDone = (terminalId: string): boolean => {
    const session = sessions.get(terminalId); if (!session) return false;
    const w = getCodexWatchdog(session);
    if (!w.unqualified || w.holdReason !== "completion-unverified") return false;
    appendDebugLog(session, `p39b-release-held-for-seat-done session=${terminalId}`);
    clearCodexTurnWatchdog(session);
    session.stateTracker.forceState("idle");
    emitStateIfChanged(session, terminalId, "idle");
    return session.agentState === "idle";
  };
  const getLogTruth = (terminalId: string) => {
    if (!isLogTruthEnabled()) return undefined;
    const e = p27State.get(terminalId);
    if (!e) return undefined;
    return { mode: logTruthMode(), logState: e.display.state, stateSource: e.display.stateSource, stateAgeSec: e.display.stateAgeSec, legacyState: e.legacy, ui: process.env.OCTO_LOG_TRUTH_UI !== "0" };
  };

  const emitStateIfChanged = (
    session: TerminalSession,
    sessionId: string,
    nextState: AgentRuntimeState | null,
  ) => {
    if (!nextState || nextState === session.agentState) {
      return;
    }

    session.agentState = nextState;
    appendDebugLog(session, `state-change session=${sessionId} state=${nextState}`);
    appendTranscriptEvent(session, sessionId, {
      type: "state_change",
      state: nextState,
      timestamp: new Date().toISOString(),
    });
    onStateChange?.(sessionId, nextState, session.lastToolName);
    broadcastMessage(session, {
      type: "state",
      state: nextState,
      ...(session.lastToolName ? { toolName: session.lastToolName } : {}),
    });
  };

  const resolveSession =
    resolveTerminalSession ??
    ((terminalId: string) => {
      if (!terminals.has(terminalId)) {
        return null;
      }
      const terminal = terminals.get(terminalId);
      return {
        sessionId: terminalId,
        tentacleId: terminal?.tentacleId ?? terminalId,
      };
    });

  const clearIdleCloseTimer = (session: TerminalSession) => {
    if (!session.idleCloseTimer) {
      return;
    }

    clearTimeout(session.idleCloseTimer);
    session.idleCloseTimer = undefined;
  };

  const appendScrollback = (session: TerminalSession, chunk: string) => {
    let nextChunk = chunk;
    let nextChunkBytes = Buffer.byteLength(nextChunk, "utf8");
    if (nextChunkBytes > scrollbackMaxBytes) {
      const chunkBuffer = Buffer.from(nextChunk, "utf8");
      nextChunk = chunkBuffer.subarray(chunkBuffer.length - scrollbackMaxBytes).toString("utf8");
      nextChunkBytes = Buffer.byteLength(nextChunk, "utf8");
      session.scrollbackChunks = [];
      session.scrollbackBytes = 0;
    }

    session.scrollbackChunks.push(nextChunk);
    session.scrollbackBytes += nextChunkBytes;
    while (session.scrollbackBytes > scrollbackMaxBytes && session.scrollbackChunks.length > 0) {
      const removedChunk = session.scrollbackChunks.shift();
      if (!removedChunk) {
        break;
      }

      session.scrollbackBytes -= Buffer.byteLength(removedChunk, "utf8");
    }
  };

  const stripBrokenLeadingAnsi = (text: string): string => {
    let nextText = text;

    while (nextText.length > 0) {
      if (nextText.startsWith("\u001b")) {
        return nextText;
      }

      const oscMatch = nextText.match(BROKEN_OSC_TAIL_RE);
      if (oscMatch) {
        nextText = nextText.slice(oscMatch[0].length);
        continue;
      }

      const csiTailMatch = nextText.match(/^\[[0-9:;<=>?]*[ -/]*[@-~]/);
      if (csiTailMatch) {
        nextText = nextText.slice(csiTailMatch[0].length);
        continue;
      }

      const orphanedCsiTailMatch = nextText.match(
        /^(?=[0-9:;<=>?]*[;:<=>?])[0-9:;<=>?]*[ -/]*[@-~]/,
      );
      if (orphanedCsiTailMatch) {
        nextText = nextText.slice(orphanedCsiTailMatch[0].length);
        continue;
      }

      break;
    }

    return nextText;
  };

  const sendHistory = (websocket: WebSocket, session: TerminalSession) => {
    if (session.scrollbackChunks.length === 0) {
      return;
    }

    sendMessage(websocket, {
      type: "history",
      data: stripBrokenLeadingAnsi(session.scrollbackChunks.join("")),
    });
  };

  const closeSession = (sessionId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) {
      return false;
    }

    clearIdleCloseTimer(session);
    closeTranscript(session, sessionId, {
      type: "session_end",
      reason: "session_close",
      timestamp: new Date().toISOString(),
    });
    // Close attached clients now so their close handlers run while this
    // session is still the map owner, instead of firing later against a
    // successor session under the same terminal id.
    for (const websocket of session.clients) {
      try {
        websocket.close();
      } catch {
        // Ignore socket teardown errors.
      }
    }
    session.clients.clear();
    try {
      session.pty.kill();
    } catch {
      // Ignore teardown errors; session will still be discarded.
    }

    if (session.statePollTimer) {
      clearInterval(session.statePollTimer);
    }
    clearCodexTurnWatchdog(session);
    clearComposerTimers(session);
    const pending = session.p33Pending;
    if (pending?.timer) clearTimeout(pending.timer);
    if (session.initialPromptPollTimer) {
      clearInterval(session.initialPromptPollTimer);
      session.initialPromptPollTimer = undefined;
    }
    session.debugLog?.end();
    sessions.delete(sessionId);
    return true;
  };

  const INITIAL_PROMPT_MIN_WAIT_MS = 5_000;
  const INITIAL_PROMPT_QUIESCENCE_MS = 1_500;
  const INITIAL_PROMPT_POLL_INTERVAL_MS = 300;
  const INITIAL_PROMPT_MAX_WAIT_MS = 90_000;
  const INITIAL_PROMPT_SUBMIT_OFFSETS_MS = [1_500, 4_500, 9_000];
  const BRACKETED_PASTE_START = "\x1b[200~";
  const BRACKETED_PASTE_END = "\x1b[201~";

  const scheduleIdleCloseIfNeeded = (session: TerminalSession, sessionId: string) => {
    // A socket close handler can fire after its session was already closed and
    // replaced (e.g. stop → start). Arming a timer on that stale object would
    // later closeSession(sessionId) and kill the successor session.
    if (sessions.get(sessionId) !== session) {
      return;
    }

    if (session.keepAliveWithoutClients) {
      return;
    }

    if (session.clients.size > 0 || session.directListeners.size > 0) {
      return;
    }

    appendDebugLog(
      session,
      `idle-grace-start session=${sessionId} timeoutMs=${sessionIdleGraceMs}`,
    );
    clearIdleCloseTimer(session);
    session.idleCloseTimer = setTimeout(() => {
      if (sessions.get(sessionId) !== session) {
        return;
      }
      appendDebugLog(session, `idle-grace-expired session=${sessionId}`);
      closeSession(sessionId);
    }, sessionIdleGraceMs);
  };

  const ensureAgentBootstrapped = (sessionId: string, session: TerminalSession) => {
    if (session.isBootstrapCommandSent) {
      return;
    }

    session.isBootstrapCommandSent = true;
    const terminal = terminals.get(session.terminalId);
    const provider =
      session.agentProviderOverride ?? terminal?.agentProvider ?? DEFAULT_AGENT_PROVIDER;

    const bootstrapCommand =
      TERMINAL_BOOTSTRAP_COMMANDS[provider] ?? TERMINAL_BOOTSTRAP_COMMANDS[DEFAULT_AGENT_PROVIDER];
    appendDebugLog(session, `bootstrap session=${sessionId} command=${bootstrapCommand}`);
    const bootstrapSentAt = Date.now();
    session.bootstrapAt = bootstrapSentAt;
    session.lastPtyOutputAt = bootstrapSentAt;
    session.pty.write(`${bootstrapCommand}\r`);

    // Defer initial prompt/draft delivery until the agent CLI is quiescent
    // (no PTY output for a settled period) AND at least the minimum wait has
    // elapsed. This avoids pasting into the shell or mid-boot, which caused
    // prompts to be echoed verbatim instead of executed.
    const hasPrompt = Boolean(session.initialPrompt) && !session.isInitialPromptSent;
    const hasDraft =
      Boolean(session.initialInputDraft) &&
      !session.isInitialInputDraftSent &&
      !session.initialPrompt;

    if (!hasPrompt && !hasDraft) {
      return;
    }

    const attemptInitialDelivery = () => {
      if (sessions.get(sessionId) !== session) {
        if (session.initialPromptPollTimer) {
          clearInterval(session.initialPromptPollTimer);
          session.initialPromptPollTimer = undefined;
        }
        return;
      }

      const now = Date.now();
      const elapsedSinceBootstrap = now - (session.bootstrapAt ?? now);
      const elapsedSinceLastOutput = now - (session.lastPtyOutputAt ?? now);
      const quiescenceReached =
        elapsedSinceBootstrap >= INITIAL_PROMPT_MIN_WAIT_MS &&
        elapsedSinceLastOutput >= INITIAL_PROMPT_QUIESCENCE_MS;
      const timeoutReached = elapsedSinceBootstrap >= INITIAL_PROMPT_MAX_WAIT_MS;

      if (!quiescenceReached && !timeoutReached) {
        return;
      }

      if (session.initialPromptPollTimer) {
        clearInterval(session.initialPromptPollTimer);
        session.initialPromptPollTimer = undefined;
      }

      appendDebugLog(
        session,
        `initial-deliver session=${sessionId} elapsed=${elapsedSinceBootstrap} quiet=${elapsedSinceLastOutput} reason=${quiescenceReached ? "quiescence" : "timeout"}`,
      );

      if (session.initialPrompt && !session.isInitialPromptSent) {
        session.isInitialPromptSent = true;
        const prompt = session.initialPrompt ?? "";
        session.pty.write(`${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`);
        // Claude Code ≥2.1 collapses multi-line pastes into a preview
        // placeholder that needs Enter to send. Under concurrent cold-boots
        // (e.g. a swarm spawning N scanners at once) a single Enter sometimes
        // races the paste-preview render. Send \r at several offsets so at
        // least one lands after the widget is ready. Extra Enters on a
        // now-empty input buffer are harmless no-ops.
        for (const offset of INITIAL_PROMPT_SUBMIT_OFFSETS_MS) {
          setTimeout(() => {
            if (sessions.get(sessionId) !== session) {
              return;
            }
            appendDebugLog(session, `initial-prompt-submit session=${sessionId} offset=${offset}`);
            session.pty.write("\r");
          }, offset);
        }
        return;
      }

      if (session.initialInputDraft && !session.isInitialInputDraftSent) {
        session.isInitialInputDraftSent = true;
        const draft = session.initialInputDraft ?? "";
        session.pty.write(`${BRACKETED_PASTE_START}${draft}${BRACKETED_PASTE_END}`);
      }
    };

    session.initialPromptPollTimer = setInterval(
      attemptInitialDelivery,
      INITIAL_PROMPT_POLL_INTERVAL_MS,
    );
  };

  const ensureSession = (sessionId: string, tentacleId: string) => {
    const existingSession = sessions.get(sessionId);
    if (existingSession) {
      return existingSession;
    }

    const terminalRecord = terminals.get(sessionId);

    const tentacleCwd = getTentacleWorkspaceCwd(tentacleId);
    if (!existsSync(tentacleCwd)) {
      throw new Error(`Terminal working directory does not exist: ${tentacleCwd}`);
    }

    ensureNodePtySpawnHelperExecutable();
    const shellLaunch = getShellLaunch();

    let pty: IPty;
    try {
      pty = spawn(shellLaunch.command, shellLaunch.args, {
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS,
        cwd: tentacleCwd,
        env: createShellEnvironment({ octogentSessionId: sessionId }),
        name: "xterm-256color",
      });
    } catch (error) {
      throw new Error(
        `Unable to start terminal shell (${shellLaunch.command}): ${toErrorMessage(error)}`,
      );
    }

    const stateTracker = new AgentStateTracker();
    const debugLog = createDebugLog(sessionId);
    const transcriptLog = createTranscriptLog(sessionId);
    const session: TerminalSession = {
      terminalId: sessionId,
      tentacleId,
      pty,
      clients: new Set(),
      directListeners: new Set(),
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      agentState: stateTracker.currentState,
      stateTracker,
      isBootstrapCommandSent: false,
      scrollbackChunks: [],
      scrollbackBytes: 0,
      transcriptEventCount: 0,
      pendingInput: "",
      hasTranscriptEnded: false,
      keepAliveWithoutClients: Boolean(terminalRecord?.initialPrompt),
    };
    if (debugLog) {
      session.debugLog = debugLog;
    }
    session.transcriptLog = transcriptLog;

    appendDebugLog(session, `session-start session=${sessionId} tentacle=${tentacleId}`);
    appendTranscriptEvent(session, sessionId, {
      type: "session_start",
      timestamp: new Date().toISOString(),
    });
    session.statePollTimer = setInterval(() => {
      // A Codex delivery latch stays "processing" until reconcile or an explicit clear.
      // The 1.6s output idle poll must not drop it while the turn id is still armed.
      const watchdog = getCodexWatchdog(session);
      if (watchdog.turnId && !watchdog.timedOut) return;
      emitStateIfChanged(session, sessionId, session.stateTracker.poll(Date.now()));
    }, 300);

    session.pty.onData((chunk) => {
      appendDebugLog(session, `pty-output session=${sessionId} chunk=${JSON.stringify(chunk)}`);
      session.lastPtyOutputAt = Date.now();
      appendScrollback(session, chunk);
      const nextState = session.stateTracker.observeChunk(chunk, Date.now());
      broadcastMessage(session, {
        type: "output",
        data: chunk,
      });
      emitStateIfChanged(session, sessionId, nextState);
    });

    session.pty.onExit(({ exitCode, signal }) => {
      const message = `\r\n[terminal exited (code ${exitCode}, signal ${signal})]\r\n`;
      broadcastMessage(session, {
        type: "output",
        data: message,
      });
      for (const client of session.clients) {
        if (client.readyState === 1) {
          client.close();
        }
      }

      appendDebugLog(
        session,
        `session-exit session=${sessionId} code=${exitCode} signal=${signal}`,
      );
      closeTranscript(session, sessionId, {
        type: "session_end",
        reason: "pty_exit",
        ...(Number.isFinite(exitCode) ? { exitCode } : {}),
        ...(Number.isFinite(signal) ? { signal } : {}),
        timestamp: new Date().toISOString(),
      });
      if (session.statePollTimer) {
        clearInterval(session.statePollTimer);
      }
      if (session.initialPromptPollTimer) {
        clearInterval(session.initialPromptPollTimer);
        session.initialPromptPollTimer = undefined;
      }
      session.debugLog?.end();
      sessions.delete(sessionId);
    });

    // Propagate initial prompt from the terminal definition, if set.
    if (terminalRecord?.initialPrompt) {
      session.initialPrompt = terminalRecord.initialPrompt;
    }
    if (terminalRecord?.initialInputDraft) {
      session.initialInputDraft = terminalRecord.initialInputDraft;
    }

    sessions.set(sessionId, session);
    return session;
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const terminalId = getTerminalId(request);
    if (!terminalId) {
      return false;
    }

    const resolvedSession = resolveSession(terminalId);
    if (!resolvedSession) {
      return false;
    }
    const { sessionId, tentacleId } = resolvedSession;

    websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      let session: TerminalSession;
      try {
        session = ensureSession(sessionId, tentacleId);
      } catch (error) {
        sendMessage(websocket, {
          type: "output",
          data: `\r\n[terminal failed to start: ${toErrorMessage(error)}]\r\n`,
        });
        websocket.close();
        return;
      }

      session.clients.add(websocket);
      appendDebugLog(session, `ws-open session=${sessionId} clients=${session.clients.size}`);
      clearIdleCloseTimer(session);
      // Attach-without-bootstrap: viewing a dormant fleet record (registered
      // with fleet metadata but no initialPrompt) must not boot a promptless
      // agent — those wake only via the start endpoint, which stamps the
      // prompt onto the record first. Non-fleet terminals keep the legacy
      // boot-on-attach behavior.
      const attachTerminalRecord = terminals.get(sessionId);
      const isDormantFleetRecord =
        Boolean(attachTerminalRecord?.metadata?.fleetId) && !attachTerminalRecord?.initialPrompt;
      if (!isDormantFleetRecord) {
        ensureAgentBootstrapped(sessionId, session);
      }
      sendHistory(websocket, session);
      sendMessage(websocket, {
        type: "state",
        state: session.agentState,
      });

      websocket.on("message", (raw: unknown) => {
        const text =
          typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString() : String(raw);
        try {
          const payload = JSON.parse(text) as
            | { type: "input"; data: string }
            | { type: "resize"; cols: number; rows: number };

          if (payload.type === "input" && typeof payload.data === "string") {
            observeTypedInput(sessionId, payload.data);
            appendDebugLog(
              session,
              `ws-input session=${sessionId} data=${JSON.stringify(payload.data)}`,
            );
            // Server-side bracketed-paste guard: when the WS payload is
            // multi-line or large, treat it as a paste and wrap it. xterm.js
            // only auto-wraps when Claude Code has emitted \x1b[?2004h and
            // the mode is currently active — during phases like the post-2.1
            // preview-placeholder, TOS dialogs, or trust prompts, that mode
            // can be off and pastes arrive raw. Wrapping here is idempotent
            // (we skip if already wrapped) and matches the contract the
            // initialPrompt path uses.
            const inputData = payload.data;
            const looksLikePaste = inputData.length > 80 || /\n/.test(inputData);
            const alreadyWrapped = inputData.startsWith(BRACKETED_PASTE_START);
            const ptyData =
              looksLikePaste && !alreadyWrapped
                ? `${BRACKETED_PASTE_START}${inputData}${BRACKETED_PASTE_END}`
                : inputData;
            session.pty.write(ptyData);
            if (/[\r\n]/.test(payload.data)) {
              emitStateIfChanged(
                session,
                sessionId,
                session.stateTracker.observeSubmit(Date.now()),
              );
            }
            return;
          }

          if (
            payload.type === "resize" &&
            Number.isFinite(payload.cols) &&
            Number.isFinite(payload.rows)
          ) {
            const nextCols = Math.max(20, Math.floor(payload.cols));
            const nextRows = Math.max(10, Math.floor(payload.rows));
            if (session.cols === nextCols && session.rows === nextRows) {
              return;
            }

            session.cols = nextCols;
            session.rows = nextRows;
            session.pty.resize(nextCols, nextRows);
          }
        } catch {
          session.pty.write(text);
        }
      });

      websocket.on("close", () => {
        session.clients.delete(websocket);
        appendDebugLog(session, `ws-close session=${sessionId} clients=${session.clients.size}`);
        scheduleIdleCloseIfNeeded(session, sessionId);
      });
    });

    return true;
  };

  const close = () => {
    for (const sessionId of sessions.keys()) {
      closeSession(sessionId);
    }
  };

  const connectDirect = (
    terminalId: string,
    listener: DirectSessionListener,
  ): (() => void) | null => {
    const resolvedSession = resolveSession(terminalId);
    if (!resolvedSession) {
      return null;
    }
    const { sessionId, tentacleId } = resolvedSession;

    let session: TerminalSession;
    try {
      session = ensureSession(sessionId, tentacleId);
    } catch {
      return null;
    }

    session.directListeners.add(listener);
    clearIdleCloseTimer(session);
    const directTerminalRecord = terminals.get(sessionId);
    const isDormantFleetRecord =
      Boolean(directTerminalRecord?.metadata?.fleetId) && !directTerminalRecord?.initialPrompt;
    if (!isDormantFleetRecord) {
      ensureAgentBootstrapped(sessionId, session);
    }

    // Send history and current state to the new listener
    if (session.scrollbackChunks.length > 0) {
      listener({ type: "history", data: session.scrollbackChunks.join("") });
    }
    listener({ type: "state", state: session.agentState });

    return () => {
      session.directListeners.delete(listener);
      scheduleIdleCloseIfNeeded(session, sessionId);
    };
  };

  const startSession = (
    terminalId: string,
    agentProviderOverride?: TerminalAgentProvider,
  ): boolean => {
    const resolvedSession = resolveSession(terminalId);
    if (!resolvedSession) {
      return false;
    }

    const { sessionId, tentacleId } = resolvedSession;
    let session: TerminalSession;
    try {
      session = ensureSession(sessionId, tentacleId);
    } catch {
      return false;
    }

    // Adopt an attach-created bare-shell session: the wake prompt was stamped
    // onto the terminal record after this session was created, so copy it in
    // and keep the woken session alive without clients.
    const terminalRecord = terminals.get(sessionId);
    if (!session.isBootstrapCommandSent && terminalRecord?.initialPrompt) {
      session.initialPrompt = terminalRecord.initialPrompt;
      session.isInitialPromptSent = false;
      session.keepAliveWithoutClients = true;
    }

    // A wake may select a provider for this session only (for example, the
    // WhatsApp policy uses Codex). Never mutate the durable terminal record:
    // later ordinary wakes still use its configured provider.
    if (!session.isBootstrapCommandSent && agentProviderOverride !== undefined) {
      session.agentProviderOverride = agentProviderOverride;
    }

    clearIdleCloseTimer(session);
    ensureAgentBootstrapped(sessionId, session);
    return true;
  };

  const scheduleComposerSubmit = (terminalId: string, session: TerminalSession) => {
    const provider = getEffectiveAgentProvider(terminalId);
    // Claude's composer needs Enters at 0.2s / 1s / 3s. Codex needs one soon after the paste.
    const offsets = provider === "claude-code" ? [200, 1_000, 3_000] : [200];
    for (const offset of offsets) {
      const timer = setTimeout(() => {
        if (!isSessionActive(terminalId, session) || session.deliveryBlocked) return;
        writeOwnedPrompt(terminalId, session, "\r");
        emitStateIfChanged(session, terminalId, session.stateTracker.observeSubmit(Date.now()));
        scheduleEnterRetry(terminalId, session);
      }, offset);
      trackComposerTimer(session, timer);
    }
  };

  const armCodexDelivery = (terminalId: string, session: TerminalSession) => {
    if (getEffectiveAgentProvider(terminalId) !== "codex") return;
    const watchdog = getCodexWatchdog(session);
    if (!watchdog.turnId) {
      watchdog.turnId = `octogent-turn-${watchdog.processGeneration}-${randomUUID()}`;
      watchdog.submitted = true;
      p27SubmitAt.set(session, Date.now());
    }
    if (codexTurnWatchdogMs > 0 && !watchdog.timer && !watchdog.timedOut) {
      const turnId = watchdog.turnId;
      watchdog.timer = setTimeout(() => {
        watchdog.timer = undefined;
        if (watchdog.turnId === turnId) watchdog.timedOut = true;
      }, codexTurnWatchdogMs);
    }
  };

  const writeInput = (terminalId: string, data: string): boolean => {
    p39bLastInput.set(terminalId, Date.now());
    const session = sessions.get(terminalId);
    if (!session) {
      return false;
    }
    // P33: once an Enter retry fails, automated delivery must not type more text
    // into the dirty composer. This refusal sticks until stop+resume.
    if (session.deliveryBlocked !== undefined) {
      return false;
    }

    session.pty.write(data);
    if (/[\r\n]/.test(data)) {
      emitStateIfChanged(session, terminalId, session.stateTracker.observeSubmit(Date.now()));
    }
    const provider = getEffectiveAgentProvider(terminalId);
    if (provider === "codex" && (data.includes(BRACKETED_PASTE_START) || /[\r\n]/.test(data) || codexTurnWatchdogMs > 0)) {
      armCodexDelivery(terminalId, session);
    }
    if (/[\r\n]/.test(data) && (provider === "codex" || (provider === "claude-code" && isEnterRetryEnabled()))) {
      if (isEnterRetryEnabled()) {
        const pasteOnly = data.replaceAll(BRACKETED_PASTE_START, "").replaceAll(BRACKETED_PASTE_END, "");
        const tid = provider === "codex" ? getCodexWatchdog(session).turnId : undefined;
        session.p33Pending = {
          at: Date.now(),
          text: pasteOnly.replace(/[\r\n]+$/g, ""),
          ...(tid ? { turnId: tid } : {}),
        };
      }
      scheduleComposerSubmit(terminalId, session);
    }
    return true;
  };

  // #45 Phase 3 [D9] chat send-message adapter: record the user's chat turn as an input_submit
  // transcript event so it surfaces in the conversation transcript immediately (the octogent-native
  // form of the legacy "store user message" step). Append-only, guarded by an open transcript log —
  // no effect on any existing PTY/session flow.
  const recordInputSubmit = (terminalId: string, submitId: string, text: string): boolean => {
    const session = sessions.get(terminalId);
    if (!session) {
      return false;
    }

    appendTranscriptEvent(session, terminalId, {
      type: "input_submit",
      submitId,
      text,
      timestamp: new Date().toISOString(),
    });
    return true;
  };

  const resizeSession = (terminalId: string, cols: number, rows: number): boolean => {
    const session = sessions.get(terminalId);
    if (!session) {
      return false;
    }

    const nextCols = Math.max(20, Math.floor(cols));
    const nextRows = Math.max(10, Math.floor(rows));
    if (session.cols === nextCols && session.rows === nextRows) {
      return true;
    }

    session.cols = nextCols;
    session.rows = nextRows;
    session.pty.resize(nextCols, nextRows);
    return true;
  };

  const setDetectedAgentProvider = (terminalId: string, provider: TerminalAgentProvider): boolean => {
    if (!sessions.has(terminalId) && !terminals.has(terminalId)) return false;
    detectedProviders.set(terminalId, provider);
    return true;
  };

  const startShellSession = (terminalId: string): boolean => {
    const resolvedSession = resolveSession(terminalId);
    if (!resolvedSession) return false;
    try {
      const session = ensureSession(resolvedSession.sessionId, resolvedSession.tentacleId);
      session.keepAliveWithoutClients = true;
      return true;
    } catch {
      return false;
    }
  };

  const prepareSessionLaunch = async (terminalId: string): Promise<boolean> =>
    terminals.has(terminalId) || sessions.has(terminalId);

  const refreshProviderPresence = async () => {
    if (!readProcessIdentities) return;
    const processes = await readProcessIdentities();
    for (const [terminalId, session] of sessions) {
      const pid = session.pty.pid;
      const childNames = processes
        .filter((process) => process.parentPid === pid)
        .map((process) => process.name.toLowerCase());
      if (childNames.some((name) => name.includes("claude"))) detectedProviders.set(terminalId, "claude-code");
      else if (childNames.some((name) => name.includes("codex"))) detectedProviders.set(terminalId, "codex");
    }
  };

  const isCodexTurnTimedOut = (terminalId: string) => {
    const session = sessions.get(terminalId);
    return session ? getCodexWatchdog(session).timedOut : false;
  };

  return {
    closeSession,
    handleUpgrade,
    connectDirect,
    startSession,
    startShellSession,
    prepareSessionLaunch,
    refreshProviderPresence,
    setDetectedAgentProvider,
    getEffectiveAgentProvider,
    getDeliveryBlocked,
    observeTypedInput,
    reconcileLatch,
    getLogTruth,
    getSeatDoneFacts,
    releaseHeldForSeatDone,
    isCodexTurnTimedOut,
    writeInput,
    recordInputSubmit,
    resizeSession,
    close,
  };
};
