// P39b-wired
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { logVerbose } from "../logging";
import type { ChannelMessage, PersistedTerminal, TerminalSession } from "./types";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export const CHANNEL_MESSAGE_TTL_MS = 45 * 60 * 1000;
export const CHANNEL_MESSAGE_HELD_TTL_MS = 2 * 60 * 60 * 1000;

/** X2: durable queue. Absent => legacy in-memory behaviour (supersede-only build). */
export type ChannelQueuePersistence = {
  queuePath: string; // <state>/channel-queue.jsonl (append-only, last record per id wins)
  deadLetterPath: string; // <state>/channel-deadletter.jsonl
};

export type ChannelDeadLetter = {
  at: string;
  reason: "expired" | "superseded";
  messageId: string;
  toTerminalId: string;
  fromTerminalId: string;
  notice: string;
  message: ChannelMessage;
};

const MESSAGE_ID_PATTERN = /^msg-(\d+)$/;

export const createChannelMessaging = (deps: {
  terminals: Map<string, PersistedTerminal>;
  sessions: Map<string, TerminalSession>;
  writeInput: (terminalId: string, data: string) => boolean;
  native?: {
    enabled(id: string): boolean;
    send(id: string, sender: string, content: string, key: string): ChannelMessage | null;
    list(id: string): ChannelMessage[];
  };
  persistence?: ChannelQueuePersistence;
  now?: () => number;
  ttlMs?: number;
  heldTtlMs?: number;
  onDeadLetter?: (entry: ChannelDeadLetter) => void;
  /** P39b: ids of pending messages to drop as stale before typing. */
  beforeDeliver?: (terminalId: string, pending: ChannelMessage[]) => string[];
  /** P39b: release a held waiter when every pending message is a deliverable SEAT DONE ping. */
  releaseHeldForPings?: (terminalId: string, pending: ChannelMessage[]) => boolean;
}) => {
  const { terminals, sessions, writeInput, persistence } = deps;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? CHANNEL_MESSAGE_TTL_MS;
  const heldTtlMs = deps.heldTtlMs ?? CHANNEL_MESSAGE_HELD_TTL_MS;
  const channelQueues = new Map<string, ChannelMessage[]>();
  let channelMessageCounter = 0;

  const bumpCounter = (messageId: string) => {
    const n = Number(MESSAGE_ID_PATTERN.exec(messageId)?.[1] ?? 0);
    if (Number.isSafeInteger(n) && n > channelMessageCounter) channelMessageCounter = n;
  };

  const persist = (message: ChannelMessage) => {
    if (!persistence) return;
    try {
      mkdirSync(dirname(persistence.queuePath), { recursive: true });
      appendFileSync(persistence.queuePath, `${JSON.stringify(message)}\n`, "utf8");
    } catch (error) {
      logVerbose(`[Channel] queue persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const readJsonl = (path: string): unknown[] => {
    if (!existsSync(path)) return [];
    const out: unknown[] = [];
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* torn tail line: skip */
      }
    }
    return out;
  };

  if (persistence) {
    const latest = new Map<string, ChannelMessage>();
    for (const raw of readJsonl(persistence.queuePath)) {
      const m = raw as ChannelMessage;
      if (!m || typeof m.messageId !== "string" || typeof m.toTerminalId !== "string" || typeof m.content !== "string") continue;
      latest.delete(m.messageId);
      latest.set(m.messageId, m);
    }
    for (const raw of readJsonl(persistence.deadLetterPath)) {
      const id = (raw as { messageId?: unknown })?.messageId;
      if (typeof id === "string") bumpCounter(id);
    }
    const ordered = [...latest.values()].sort(
      (a, b) =>
        Number(MESSAGE_ID_PATTERN.exec(a.messageId)?.[1] ?? 0) -
        Number(MESSAGE_ID_PATTERN.exec(b.messageId)?.[1] ?? 0),
    );
    for (const m of ordered) {
      bumpCounter(m.messageId);
      const q = channelQueues.get(m.toTerminalId) ?? [];
      q.push(m);
      channelQueues.set(m.toTerminalId, q);
    }
    try {
      if (existsSync(persistence.queuePath)) {
        const tmp = `${persistence.queuePath}.tmp`;
        writeFileSync(tmp, ordered.map((m) => `${JSON.stringify(m)}\n`).join(""), "utf8");
        renameSync(tmp, persistence.queuePath);
      }
    } catch (error) {
      logVerbose(`[Channel] queue compaction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    logVerbose(`[Channel] Loaded ${ordered.length} channel record(s); next id msg-${channelMessageCounter + 1}`);
  }

  const deadLetter = (message: ChannelMessage, reason: ChannelDeadLetter["reason"], notice: string) => {
    const entry: ChannelDeadLetter = {
      at: new Date(now()).toISOString(),
      reason,
      messageId: message.messageId,
      toTerminalId: message.toTerminalId,
      fromTerminalId: message.fromTerminalId,
      notice,
      message: { ...message },
    };
    if (persistence) {
      try {
        mkdirSync(dirname(persistence.deadLetterPath), { recursive: true });
        appendFileSync(persistence.deadLetterPath, `${JSON.stringify(entry)}\n`, "utf8");
      } catch (error) {
        logVerbose(`[Channel] dead-letter write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.warn(`[Channel] ${notice}`);
    try {
      deps.onDeadLetter?.(entry);
    } catch {
      /* notice sink must not break the queue */
    }
  };

  const isPending = (m: ChannelMessage) => !m.delivered && !m.superseded && !m.expired;

  const expireStale = (terminalId: string) => {
    const queue = channelQueues.get(terminalId);
    if (!queue) return;
    const held = (sessions.get(terminalId)?.agentState as string | undefined) === "held";
    const limit = held ? heldTtlMs : ttlMs;
    const t = now();
    for (const m of queue) {
      if (!isPending(m)) continue;
      const age = t - Date.parse(m.timestamp);
      if (!(age > limit)) continue;
      m.expired = { at: new Date(t).toISOString(), afterMs: limit, ...(held ? { held: true } : {}) };
      persist(m);
      const mins = Math.round(limit / 60000);
      deadLetter(
        m,
        "expired",
        `${m.messageId} to ${terminalId} expired after ${mins}m undelivered${held ? " (seat held)" : ""}; re-dispatch or drop`,
      );
    }
  };

  const composePrompt = (messages: ChannelMessage[]): string => {
    const lines = messages.map((message) => {
      const fromTerminal = terminals.get(message.fromTerminalId);
      const displayName = fromTerminal?.tentacleName ?? message.fromTerminalId;
      return `[Channel message from ${displayName}]: ${message.content}`;
    });
    return `${BRACKETED_PASTE_START}${lines.join("\n")}${BRACKETED_PASTE_END}\r`;
  };

  const markSuperseded = (
    m: ChannelMessage,
    meta: { at: string; by: string; reason: string; custodyRef?: string },
  ) => {
    m.superseded = {
      at: meta.at,
      by: meta.by,
      reason: meta.reason,
      ...(meta.custodyRef ? { custodyRef: meta.custodyRef } : {}),
    };
    persist(m);
    deadLetter(m, "superseded", `${m.messageId} to ${m.toTerminalId} superseded by ${meta.by} (${meta.reason}); not delivered`);
  };

  const deliverChannelMessages = (terminalId: string): void => {
    const queue = channelQueues.get(terminalId);
    if (!queue || queue.length === 0) {
      return;
    }

    try {
      const p = queue.filter(isPending);
      if (deps.beforeDeliver && p.length > 0) {
        const drop = deps.beforeDeliver(terminalId, p);
        const at = new Date(now()).toISOString();
        for (const m of p) if (drop.includes(m.messageId)) markSuperseded(m, { at, by: "octogent-p39b", reason: "seat-done-stale" });
      }
      const p2 = queue.filter(isPending);
      if (p2.length > 0 && (sessions.get(terminalId)?.agentState as string | undefined) === "held") {
        deps.releaseHeldForPings?.(terminalId, p2);
      }
    } catch {
      /* P39b never breaks delivery */
    }

    const session = sessions.get(terminalId);
    if (!session || session.agentState !== "idle" || session.claudeTurnPending) {
      return;
    }

    expireStale(terminalId);
    const undelivered = queue.filter(isPending);
    if (undelivered.length === 0) {
      return;
    }

    const prompt = composePrompt(undelivered);
    logVerbose(`[Channel] Delivering ${undelivered.length} message(s) to ${terminalId}`);

    if (writeInput(terminalId, prompt)) {
      const deliveredAt = new Date(now()).toISOString();
      for (const m of undelivered) {
        m.delivered = true;
        m.deliveredAt = deliveredAt;
        persist(m);
      }
    }
  };

  const sweepAll = () => {
    for (const terminalId of channelQueues.keys()) {
      if (!deps.native?.enabled(terminalId)) expireStale(terminalId);
    }
  };

  /** P33: flag the message(s) written at/after sinceIso (else the latest delivered) as not submitted. */
  const markNotSubmitted = (terminalId: string, reason: string, detectedAt: string, sinceIso?: string): string[] => {
    const queue = channelQueues.get(terminalId) ?? [];
    const delivered = queue.filter((m) => m.delivered && !m.notSubmitted);
    const since = sinceIso ? Date.parse(sinceIso) - 5000 : Number.NaN;
    let hits = Number.isFinite(since) ? delivered.filter((m) => Date.parse(m.deliveredAt ?? m.timestamp) >= since) : [];
    if (hits.length === 0 && delivered.length > 0) hits = [delivered[delivered.length - 1]!];
    for (const m of hits) {
      m.notSubmitted = true;
      m.notSubmittedReason = reason;
      m.notSubmittedAt = detectedAt;
      persist(m);
    }
    return hits.map((m) => m.messageId);
  };

  return {
    markNotSubmitted,
    sendChannelMessage(
      toTerminalId: string,
      fromTerminalId: string,
      content: string,
      options?: { immediateOnly?: boolean; idempotencyKey?: string; deliveryVersion?: number; supersedeKey?: string },
    ): ChannelMessage | null {
      if (!terminals.has(toTerminalId)) {
        return null;
      }
      if (deps.native?.enabled(toTerminalId)) {
        if (options?.immediateOnly || options?.deliveryVersion !== 2 || !options.idempotencyKey) return null;
        return deps.native.send(toTerminalId, fromTerminalId, content, options.idempotencyKey);
      }
      expireStale(toTerminalId);
      const queue = channelQueues.get(toTerminalId) ?? [];
      const supersedeKey = options?.supersedeKey?.trim() || undefined;
      const sameKey = supersedeKey ? queue.filter((m) => isPending(m) && m.supersedeKey === supersedeKey) : [];
      if (
        options?.immediateOnly &&
        (sessions.get(toTerminalId)?.agentState !== "idle" ||
          sessions.get(toTerminalId)?.claudeTurnPending ||
          queue.some((m) => isPending(m) && !sameKey.includes(m)))
      ) {
        return null;
      }

      channelMessageCounter += 1;
      const message: ChannelMessage = {
        messageId: `msg-${channelMessageCounter}`,
        fromTerminalId,
        toTerminalId,
        content,
        timestamp: new Date(now()).toISOString(),
        delivered: false,
        ...(supersedeKey ? { supersedeKey } : {}),
      };
      if (sameKey.length > 0) {
        const at = new Date(now()).toISOString();
        for (const m of sameKey) {
          markSuperseded(m, { at, by: fromTerminalId || "unknown", reason: "superseded-by-key", custodyRef: message.messageId });
        }
      }

      // Guarded sends never enter the deferred queue. A refused or throwing
      // PTY write cannot leave a message for a later process incarnation.
      if (options?.immediateOnly) {
        let wrote = false;
        try {
          wrote = writeInput(toTerminalId, composePrompt([message]));
        } catch {
          wrote = false;
        }
        if (!wrote) return null;
        message.delivered = true;
        message.deliveredAt = new Date(now()).toISOString();
        queue.push(message);
        channelQueues.set(toTerminalId, queue);
        persist(message);
        return message;
      }

      queue.push(message);
      channelQueues.set(toTerminalId, queue);
      persist(message);

      logVerbose(`[Channel] Queued message ${message.messageId} from=${fromTerminalId} to=${toTerminalId}`);

      const targetSession = sessions.get(toTerminalId);
      if (targetSession && targetSession.agentState === "idle") {
        deliverChannelMessages(toTerminalId);
      }

      return message;
    },

    listChannelMessages(terminalId: string): Array<ChannelMessage & { fromTerminalName?: string }> {
      if (!deps.native?.enabled(terminalId)) expireStale(terminalId);
      const raw = deps.native?.enabled(terminalId) ? deps.native.list(terminalId) : (channelQueues.get(terminalId) ?? []);
      return raw.map((m) => {
        const fromTerminal = terminals.get(m.fromTerminalId);
        return fromTerminal?.tentacleName ? { ...m, fromTerminalName: fromTerminal.tentacleName } : m;
      });
    },

    deliverChannelMessages,

    /** Periodic expiry sweep; safe to call any time, never writes to a PTY. */
    sweepExpiredChannelMessages: sweepAll,

    supersedeChannelMessages(
      terminalId: string,
      messageIds: string[],
      meta: { by: string; reason: string; custodyRef?: string },
    ):
      | { ok: true; superseded: ChannelMessage[]; alreadySuperseded: string[] }
      | { ok: false; error: string; messageIds?: string[] } {
      if (deps.native?.enabled(terminalId)) return { ok: false, error: "native-delivery-terminal" };
      const queue = channelQueues.get(terminalId) ?? [];
      const byId = new Map(queue.map((m) => [m.messageId, m] as const));
      const missing = messageIds.filter((id) => !byId.has(id));
      if (missing.length > 0) return { ok: false, error: "unknown-message-ids", messageIds: missing };
      const delivered = messageIds.filter((id) => byId.get(id)?.delivered);
      if (delivered.length > 0) return { ok: false, error: "already-delivered", messageIds: delivered };
      const at = new Date(now()).toISOString();
      const superseded: ChannelMessage[] = [];
      const alreadySuperseded: string[] = [];
      for (const id of messageIds) {
        const m = byId.get(id) as ChannelMessage;
        if (m.superseded || m.expired) {
          alreadySuperseded.push(id);
          continue;
        }
        markSuperseded(m, { at, ...meta });
        superseded.push(m);
      }
      logVerbose(`[Channel] Superseded ${superseded.length} message(s) on ${terminalId} by=${meta.by}`);
      return { ok: true, superseded, alreadySuperseded };
    },
  };
};
