import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ConversationSearchHit,
  type ConversationSearchResult,
  type ConversationSessionDetail,
  type ConversationSessionSummary,
  type ConversationTurn,
  resolveConversationTitle,
} from "@octogent/core";

import type { AgentRuntimeState } from "../agentStateDetection";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseRuntimeState = (value: unknown): AgentRuntimeState | null =>
  value === "idle" || value === "processing" ? value : null;

export type ConversationTranscriptEventBase = {
  eventId: string;
  sessionId: string;
  tentacleId: string;
  timestamp: string;
};

export type SessionStartTranscriptEvent = ConversationTranscriptEventBase & {
  type: "session_start";
};

export type InputSubmitTranscriptEvent = ConversationTranscriptEventBase & {
  type: "input_submit";
  submitId: string;
  text: string;
};

export type OutputChunkTranscriptEvent = ConversationTranscriptEventBase & {
  type: "output_chunk";
  chunkId: string;
  text: string;
};

export type StateChangeTranscriptEvent = ConversationTranscriptEventBase & {
  type: "state_change";
  state: AgentRuntimeState;
};

export type SessionEndTranscriptEvent = ConversationTranscriptEventBase & {
  type: "session_end";
  reason: "pty_exit" | "session_close";
  exitCode?: number;
  signal?: number;
};

export type ConversationTranscriptEvent =
  | SessionStartTranscriptEvent
  | InputSubmitTranscriptEvent
  | OutputChunkTranscriptEvent
  | StateChangeTranscriptEvent
  | SessionEndTranscriptEvent;

export type ConversationTranscriptEventPayload =
  | Omit<SessionStartTranscriptEvent, "eventId" | "sessionId" | "tentacleId">
  | Omit<InputSubmitTranscriptEvent, "eventId" | "sessionId" | "tentacleId">
  | Omit<OutputChunkTranscriptEvent, "eventId" | "sessionId" | "tentacleId">
  | Omit<StateChangeTranscriptEvent, "eventId" | "sessionId" | "tentacleId">
  | Omit<SessionEndTranscriptEvent, "eventId" | "sessionId" | "tentacleId">;

export type { ConversationTurn };

export const transcriptFilenameForSession = (sessionId: string) =>
  `${encodeURIComponent(sessionId)}.jsonl`;

// #45 Phase 3 [D9] conversation-metadata sidecar. Holds the octogent-native conversation title
// (rename-conversation / generate-title adapters) + summary (conversation-summary adapter) next to
// the transcript — the "session-metadata over the transcript store" the D9 parity calls for. No LLM.
export type ConversationMeta = {
  title?: string;
  summary?: string;
};

const conversationMetaFilename = (sessionId: string) =>
  `${encodeURIComponent(sessionId)}.meta.json`;

export const readConversationMeta = (
  transcriptDirectoryPath: string,
  sessionId: string,
): ConversationMeta | null => {
  const metaPath = join(transcriptDirectoryPath, conversationMetaFilename(sessionId));
  if (!existsSync(metaPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const meta: ConversationMeta = {};
    const title = asString(parsed.title);
    if (title !== null) {
      meta.title = title;
    }
    const summary = asString(parsed.summary);
    if (summary !== null) {
      meta.summary = summary;
    }
    return meta;
  } catch {
    return null;
  }
};

/**
 * Merge a metadata patch into the conversation's sidecar (create if absent). Append-only over the
 * transcript store — never touches the transcript itself. Used by the rename / title / summary
 * adapters.
 */
export const writeConversationMeta = (
  transcriptDirectoryPath: string,
  sessionId: string,
  patch: ConversationMeta,
): ConversationMeta => {
  ensureTranscriptDirectory(transcriptDirectoryPath);
  const existing = readConversationMeta(transcriptDirectoryPath, sessionId) ?? {};
  const next: ConversationMeta = { ...existing, ...patch };
  const metaPath = join(transcriptDirectoryPath, conversationMetaFilename(sessionId));
  writeFileSync(metaPath, JSON.stringify(next), "utf8");
  return next;
};

const parseTranscriptEvent = (value: unknown): ConversationTranscriptEvent | null => {
  if (!isRecord(value)) {
    return null;
  }

  const eventType = asString(value.type);
  const eventId = asString(value.eventId);
  const sessionId = asString(value.sessionId);
  const tentacleId = asString(value.tentacleId);
  const timestamp = asString(value.timestamp);

  if (!eventType || !eventId || !sessionId || !tentacleId || !timestamp) {
    return null;
  }

  if (eventType === "session_start") {
    return {
      type: "session_start",
      eventId,
      sessionId,
      tentacleId,
      timestamp,
    };
  }

  if (eventType === "input_submit") {
    const submitId = asString(value.submitId);
    const text = asString(value.text);
    if (!submitId || text === null) {
      return null;
    }

    return {
      type: "input_submit",
      eventId,
      sessionId,
      tentacleId,
      timestamp,
      submitId,
      text,
    };
  }

  if (eventType === "output_chunk") {
    const chunkId = asString(value.chunkId);
    const text = asString(value.text);
    if (!chunkId || text === null) {
      return null;
    }

    return {
      type: "output_chunk",
      eventId,
      sessionId,
      tentacleId,
      timestamp,
      chunkId,
      text,
    };
  }

  if (eventType === "state_change") {
    const state = parseRuntimeState(value.state);
    if (!state) {
      return null;
    }

    return {
      type: "state_change",
      eventId,
      sessionId,
      tentacleId,
      timestamp,
      state,
    };
  }

  if (eventType === "session_end") {
    const reason = value.reason;
    if (reason !== "pty_exit" && reason !== "session_close") {
      return null;
    }

    const exitCode = typeof value.exitCode === "number" ? value.exitCode : undefined;
    const signal = typeof value.signal === "number" ? value.signal : undefined;

    return {
      type: "session_end",
      eventId,
      sessionId,
      tentacleId,
      timestamp,
      reason,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  return null;
};

const buildConversationSummary = (
  sessionId: string,
  events: ConversationTranscriptEvent[],
  turns: ConversationTurn[],
): ConversationSessionSummary => {
  const userTurns = turns.filter((turn) => turn.role === "user");
  const assistantTurns = turns.filter((turn) => turn.role === "assistant");
  const firstEvent = events[0] ?? null;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const lastSessionEnd =
    [...events].reverse().find((event) => event.type === "session_end") ?? null;

  return {
    sessionId,
    tentacleId: firstEvent?.tentacleId ?? null,
    // Placeholder — resolved from the metadata sidecar by readConversationSession (#45 Phase 3 D9).
    title: null,
    startedAt: firstEvent?.timestamp ?? null,
    endedAt: lastSessionEnd?.timestamp ?? null,
    lastEventAt: lastEvent?.timestamp ?? null,
    eventCount: events.length,
    turnCount: turns.length,
    userTurnCount: userTurns.length,
    assistantTurnCount: assistantTurns.length,
    firstUserTurnPreview: userTurns.length > 0 ? (userTurns[0]?.content ?? null) : null,
    lastUserTurnPreview:
      userTurns.length > 0 ? (userTurns[userTurns.length - 1]?.content ?? null) : null,
    lastAssistantTurnPreview:
      assistantTurns.length > 0
        ? (assistantTurns[assistantTurns.length - 1]?.content ?? null)
        : null,
  };
};

const parseTranscriptLines = (rawJsonl: string): ConversationTranscriptEvent[] => {
  const events: ConversationTranscriptEvent[] = [];
  const lines = rawJsonl.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const event = parseTranscriptEvent(parsed);
      if (event) {
        events.push(event);
      }
    } catch {
      // Ignore malformed lines to keep transcript parsing resilient.
    }
  }

  return events;
};

const readSessionEventsFromFile = (
  transcriptDirectoryPath: string,
  sessionId: string,
): ConversationTranscriptEvent[] => {
  const transcriptPath = join(transcriptDirectoryPath, transcriptFilenameForSession(sessionId));
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const rawJsonl = readFileSync(transcriptPath, "utf8");
  return parseTranscriptLines(rawJsonl);
};

const parseSessionIdFromFilename = (filename: string): string | null => {
  if (!filename.endsWith(".jsonl")) {
    return null;
  }

  const basename = filename.slice(0, -".jsonl".length);
  if (basename.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(basename);
  } catch {
    return null;
  }
};

const truncatePreview = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 157)}...`;
};

export const readConversationSession = (
  transcriptDirectoryPath: string,
  sessionId: string,
): ConversationSessionDetail | null => {
  const events = readSessionEventsFromFile(transcriptDirectoryPath, sessionId);
  if (events.length === 0) {
    return null;
  }

  // Only use clean turns from Claude Code's structured transcript (via Stop hook).
  const turns = readClaudeTranscriptTurns(transcriptDirectoryPath, sessionId) ?? [];
  const summary = buildConversationSummary(sessionId, events, turns);

  // #45 Phase 3 [D9] title resolution: an explicitly stored title (rename / generate-title) wins,
  // otherwise the auto-title derived from the first user turn (auto-title fold, Phase 3 m5),
  // otherwise null. The stored title lives in the metadata sidecar over the transcript store.
  const meta = readConversationMeta(transcriptDirectoryPath, sessionId);
  const resolvedTitle = resolveConversationTitle({
    storedTitle: meta?.title ?? null,
    firstUserTurnPreview: summary.firstUserTurnPreview,
  });

  return {
    ...summary,
    title: resolvedTitle,
    firstUserTurnPreview: truncatePreview(summary.firstUserTurnPreview),
    lastUserTurnPreview: truncatePreview(summary.lastUserTurnPreview),
    lastAssistantTurnPreview: truncatePreview(summary.lastAssistantTurnPreview),
    turns,
    events,
  };
};

export const listConversationSessions = (
  transcriptDirectoryPath: string,
): ConversationSessionSummary[] => {
  if (!existsSync(transcriptDirectoryPath)) {
    return [];
  }

  const sessionIds = readdirSync(transcriptDirectoryPath)
    .map((filename) => parseSessionIdFromFilename(filename))
    .filter((sessionId): sessionId is string => sessionId !== null);

  const summaries = sessionIds
    .map((sessionId) => {
      const detail = readConversationSession(transcriptDirectoryPath, sessionId);
      // Skip sessions that have no actual conversation turns — these are
      // PTY sessions that were spawned but never received any user input.
      if (!detail || detail.turnCount === 0) {
        return null;
      }

      return {
        sessionId: detail.sessionId,
        tentacleId: detail.tentacleId,
        title: detail.title,
        startedAt: detail.startedAt,
        endedAt: detail.endedAt,
        lastEventAt: detail.lastEventAt,
        eventCount: detail.eventCount,
        turnCount: detail.turnCount,
        userTurnCount: detail.userTurnCount,
        assistantTurnCount: detail.assistantTurnCount,
        firstUserTurnPreview: detail.firstUserTurnPreview,
        lastUserTurnPreview: detail.lastUserTurnPreview,
        lastAssistantTurnPreview: detail.lastAssistantTurnPreview,
      };
    })
    .filter((summary): summary is ConversationSessionSummary => summary !== null)
    .map((summary) => ({
      ...summary,
      firstUserTurnPreview: truncatePreview(summary.firstUserTurnPreview),
      lastUserTurnPreview: truncatePreview(summary.lastUserTurnPreview),
      lastAssistantTurnPreview: truncatePreview(summary.lastAssistantTurnPreview),
    }));

  return summaries.sort((left, right) => {
    const leftTime = left.lastEventAt ? Date.parse(left.lastEventAt) : 0;
    const rightTime = right.lastEventAt ? Date.parse(right.lastEventAt) : 0;
    return rightTime - leftTime;
  });
};

export const ensureTranscriptDirectory = (transcriptDirectoryPath: string) => {
  mkdirSync(transcriptDirectoryPath, { recursive: true });
};

export const deleteConversation = (transcriptDirectoryPath: string, sessionId: string) => {
  const transcriptFile = join(transcriptDirectoryPath, transcriptFilenameForSession(sessionId));
  const turnsFile = join(
    transcriptDirectoryPath,
    `${encodeURIComponent(sessionId)}.claude-turns.json`,
  );
  const metaFile = join(transcriptDirectoryPath, conversationMetaFilename(sessionId));

  for (const file of [transcriptFile, turnsFile, metaFile]) {
    try {
      if (existsSync(file)) {
        rmSync(file);
      }
    } catch {
      // Best-effort removal
    }
  }
};

export const deleteAllConversations = (transcriptDirectoryPath: string) => {
  if (!existsSync(transcriptDirectoryPath)) {
    return;
  }

  const files = readdirSync(transcriptDirectoryPath);
  for (const file of files) {
    if (
      file.endsWith(".jsonl") ||
      file.endsWith(".claude-turns.json") ||
      file.endsWith(".meta.json")
    ) {
      try {
        rmSync(join(transcriptDirectoryPath, file));
      } catch {
        // Best-effort removal
      }
    }
  }
};

const claudeTurnsFilename = (sessionId: string) =>
  `${encodeURIComponent(sessionId)}.claude-turns.json`;

export const storeClaudeTranscriptTurns = (
  transcriptDirectoryPath: string,
  sessionId: string,
  turns: ConversationTurn[],
) => {
  ensureTranscriptDirectory(transcriptDirectoryPath);
  const filePath = join(transcriptDirectoryPath, claudeTurnsFilename(sessionId));
  writeFileSync(filePath, JSON.stringify(turns), "utf8");
};

const readClaudeTranscriptTurns = (
  transcriptDirectoryPath: string,
  sessionId: string,
): ConversationTurn[] | null => {
  const filePath = join(transcriptDirectoryPath, claudeTurnsFilename(sessionId));
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }

    return parsed as ConversationTurn[];
  } catch {
    return null;
  }
};

const buildSearchSnippet = (content: string, query: string, contextChars = 80): string => {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerContent.indexOf(lowerQuery);
  if (matchIndex === -1) {
    return content
      .slice(0, contextChars * 2)
      .replace(/\s+/g, " ")
      .trim();
  }

  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(content.length, matchIndex + query.length + contextChars);
  let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < content.length) snippet = `${snippet}...`;
  return snippet;
};

export const searchConversations = (
  transcriptDirectoryPath: string,
  query: string,
): ConversationSearchResult => {
  if (!existsSync(transcriptDirectoryPath) || query.trim().length === 0) {
    return { query, hits: [] };
  }

  const lowerQuery = query.toLowerCase();
  const hits: ConversationSearchHit[] = [];

  const sessionIds = readdirSync(transcriptDirectoryPath)
    .map((filename) => parseSessionIdFromFilename(filename))
    .filter((sessionId): sessionId is string => sessionId !== null);

  for (const sessionId of sessionIds) {
    const turns = readClaudeTranscriptTurns(transcriptDirectoryPath, sessionId) ?? [];
    for (const turn of turns) {
      if (turn.content.toLowerCase().includes(lowerQuery)) {
        hits.push({
          sessionId,
          turnId: turn.turnId,
          role: turn.role,
          snippet: buildSearchSnippet(turn.content, query),
          turnStartedAt: turn.startedAt,
        });
      }
    }
  }

  return { query, hits };
};

export const conversationExportMarkdown = (conversation: ConversationSessionDetail): string => {
  const lines: string[] = [];

  for (const turn of conversation.turns) {
    const roleLabel = turn.role === "user" ? "User" : "Assistant";
    lines.push(`## ${roleLabel}`);
    lines.push("");
    lines.push(turn.content.length > 0 ? turn.content : "(empty)");
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
};
