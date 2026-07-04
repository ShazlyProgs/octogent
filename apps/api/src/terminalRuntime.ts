import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import type { TerminalSnapshot } from "@octogent/core";
import {
  AttachDocumentError,
  ConversationRenameError,
  CreateConversationError,
  SendMessageError,
  buildConversationInputSubmit,
  buildConversationRename,
  buildConversationSummaryText,
  buildCreateConversationRequest,
  buildDocumentAttachment,
  deriveConversationTitle,
  resolveSendMessageDisposition,
} from "@octogent/core";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { createChannelMessaging } from "./terminalRuntime/channelMessaging";
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_TERMINAL_INACTIVITY_THRESHOLD_MS,
  TERMINAL_ID_PREFIX,
} from "./terminalRuntime/constants";
import {
  conversationExportMarkdown,
  deleteAllConversations,
  deleteConversation,
  listConversationSessions,
  readConversationSession,
  searchConversations,
  writeConversationMeta,
} from "./terminalRuntime/conversations";
import { createGitOperations } from "./terminalRuntime/gitOperations";
import { createHookProcessor } from "./terminalRuntime/hookProcessor";
import {
  createTerminalRegistryPersistence,
  loadTerminalRegistry,
  pruneUiStateTerminalReferences,
} from "./terminalRuntime/registry";
import { createSessionRuntime } from "./terminalRuntime/sessionRuntime";
import { createDefaultGitClient } from "./terminalRuntime/systemClients";
import type { DirectSessionListener } from "./terminalRuntime/types";
import {
  type CreateTerminalRuntimeOptions,
  type PersistedTerminal,
  type PersistedUiState,
  RuntimeInputError,
  type TentacleWorkspaceMode,
  type TerminalAgentProvider,
  type TerminalNameOrigin,
  type TerminalSession,
} from "./terminalRuntime/types";
import { createWorktreeManager } from "./terminalRuntime/worktreeManager";

export type {
  GitClient,
  PersistedUiState,
  TerminalAgentProvider,
  TerminalNameOrigin,
  TentacleWorkspaceMode,
} from "./terminalRuntime/types";
export { isTerminalAgentProvider, isTerminalCompletionSoundId } from "./terminalRuntime/types";
export { RuntimeInputError } from "./terminalRuntime/types";

export const MAX_CHILDREN_PER_PARENT = 9;

/**
 * Result of submitting a chat turn into a conversation (#45 Phase 3 [D9] send-message adapter).
 * Discriminated so the HTTP route maps each case to the legacy-parity status code without a
 * try/catch: accepted → 202, busy → 409, no-session → 404, invalid-content → 400.
 */
export type SubmitConversationMessageResult =
  | { status: "accepted"; submitId: string; tentacleId: string; text: string }
  | { status: "busy"; tentacleId: string }
  | { status: "no-session" }
  | { status: "invalid-content"; error: string };

/**
 * Result of starting a chat conversation (#45 Phase 3 [D9] create-conversation adapter).
 * Discriminated so the HTTP route maps each case to the legacy-parity status code without a
 * try/catch: created → 201, invalid → 400.
 */
export type CreateConversationResult =
  | {
      status: "created";
      sessionId: string;
      tentacleId: string;
      tentacleName: string;
      workspaceMode: TentacleWorkspaceMode;
    }
  | { status: "invalid"; error: string };

/**
 * Result of renaming a conversation (#45 Phase 3 [D9] rename-conversation adapter). Discriminated
 * so the HTTP route maps each case to the legacy-parity status code: renamed → 200, invalid → 400,
 * no-conversation → 404.
 */
export type RenameConversationResult =
  | { status: "renamed"; sessionId: string; title: string }
  | { status: "invalid"; error: string }
  | { status: "no-conversation" };

/**
 * Result of generating (pinning) a conversation title (#45 Phase 3 [D9] conversation-title
 * adapter). Discriminated so the HTTP route maps each case: titled → 200 with the pinned title,
 * no-title → 200 with title:null (no derivable first turn yet), no-conversation → 404.
 */
export type GenerateConversationTitleResult =
  | { status: "titled"; sessionId: string; title: string }
  | { status: "no-title"; sessionId: string }
  | { status: "no-conversation" };

/**
 * Result of summarizing a conversation (#45 Phase 3 [D9] conversation-summary adapter).
 * Discriminated so the HTTP route maps each case: summarized → 200 with the recap, no-conversation
 * → 404.
 */
export type SummarizeConversationResult =
  | { status: "summarized"; sessionId: string; summary: string }
  | { status: "no-conversation" };

/**
 * Result of attaching a document to a conversation (#45 Phase 3 [D9] attach-document adapter).
 * Discriminated so the HTTP route maps each case: attached → 201, invalid → 400, no-conversation
 * → 404. NOTE: this is the REAL groundwork (write into the tentacle workspace + transcript link) —
 * the chat-parity row stays UNPROVEN pending a per-conversation document store + agent-ingestion
 * path; see application/attachDocument.ts + fleet/CHAT-PARITY.md.
 */
export type AttachDocumentResult =
  | {
      status: "attached";
      sessionId: string;
      filename: string;
      path: string;
      byteLength: number;
    }
  | { status: "invalid"; error: string }
  | { status: "no-conversation" };

export const createTerminalRuntime = ({
  workspaceCwd,
  projectStateDir,
  gitClient = createDefaultGitClient(),
  getApiBaseUrl = () => process.env.OCTOGENT_API_ORIGIN ?? "http://127.0.0.1:8787",
  vaultRoot,
}: CreateTerminalRuntimeOptions & { vaultRoot?: string | undefined }) => {
  const stateDir = projectStateDir ?? join(workspaceCwd, ".octogent");
  const sessions = new Map<string, TerminalSession>();
  let conversationMessageCounter = 0;
  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const terminalEventsWebsocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  const terminalEventClients = new Set<WebSocket>();
  const registryPath = join(stateDir, "state", "tentacles.json");
  const registryState = loadTerminalRegistry(registryPath);
  const registryPersistence = createTerminalRegistryPersistence(registryPath);
  const terminals = registryState.terminals;
  let uiState = registryState.uiState;
  const isDebugPtyLogsEnabled = process.env.OCTOGENT_DEBUG_PTY_LOGS === "1";
  const ptyLogDir = process.env.OCTOGENT_DEBUG_PTY_LOG_DIR ?? join(stateDir, "logs");
  const transcriptDirectoryPath = join(stateDir, "state", "transcripts");
  const persistRegistry = () => {
    uiState = pruneUiStateTerminalReferences(uiState, terminals);
    registryPersistence.schedulePersist({
      terminals,
      uiState,
    });
  };

  const worktreeManager = createWorktreeManager({
    workspaceCwd,
    gitClient,
    terminals,
    vaultRoot,
  });

  const resolveTerminalSession = (
    terminalId: string,
  ): { sessionId: string; tentacleId: string } | null => {
    const terminal = terminals.get(terminalId);
    if (terminal) {
      return {
        sessionId: terminalId,
        tentacleId: terminal.worktreeId ?? terminal.tentacleId,
      };
    }

    return null;
  };

  const broadcastTerminalStateChanged = (
    terminalId: string,
    agentRuntimeState: string,
    toolName?: string,
  ) => {
    broadcastTerminalEvent({
      type: "terminal-state-changed",
      terminalId,
      agentRuntimeState,
      ...(toolName ? { toolName } : {}),
    });
  };

  const sessionRuntime = createSessionRuntime({
    websocketServer,
    terminals,
    sessions,
    resolveTerminalSession,
    getTentacleWorkspaceCwd: worktreeManager.getTentacleWorkspaceCwd,
    isDebugPtyLogsEnabled,
    ptyLogDir,
    transcriptDirectoryPath,
    onStateChange: broadcastTerminalStateChanged,
  });

  const gitOps = createGitOperations({
    terminals,
    worktreeManager,
    gitClient,
  });

  const channelMessaging = createChannelMessaging({
    terminals,
    sessions,
    writeInput: (terminalId: string, data: string) => sessionRuntime.writeInput(terminalId, data),
  });

  const hookProcessor = createHookProcessor({
    terminals,
    sessions,
    transcriptDirectoryPath,
    getApiBaseUrl,
    persistRegistry,
    deliverChannelMessages: channelMessaging.deliverChannelMessages,
    onStateChange: broadcastTerminalStateChanged,
    ...(vaultRoot ? { vaultRoot } : {}),
  });

  const allocateTerminalId = () => {
    let candidateNumber = 1;
    while (candidateNumber < Number.MAX_SAFE_INTEGER) {
      const candidateId = `${TERMINAL_ID_PREFIX}${candidateNumber}`;
      if (terminals.has(candidateId)) {
        candidateNumber += 1;
        continue;
      }

      if (sessions.has(candidateId)) {
        candidateNumber += 1;
        continue;
      }

      if (worktreeManager.hasTentacleWorktree(candidateId)) {
        candidateNumber += 1;
        continue;
      }

      return candidateId;
    }

    throw new Error("Unable to allocate terminal id.");
  };

  const allocateDefaultTerminalName = (): string => {
    const usedNumbers = new Set<number>();
    const pattern = /^Octogent Terminal (\d+)$/;
    for (const t of terminals.values()) {
      const match = pattern.exec(t.tentacleName);
      if (match) usedNumbers.add(Number(match[1]));
    }
    let n = 1;
    while (usedNumbers.has(n)) n++;
    return `Octogent Terminal ${n}`;
  };

  const isTerminalRecentlyActive = (terminal: PersistedTerminal): boolean => {
    if (!terminal.lastActiveAt) return false;
    const thresholdMs =
      uiState.terminalInactivityThresholdMs ?? DEFAULT_TERMINAL_INACTIVITY_THRESHOLD_MS;
    return Date.now() - new Date(terminal.lastActiveAt).getTime() < thresholdMs;
  };

  const toTerminalSnapshot = (terminal: PersistedTerminal): TerminalSnapshot => {
    const session = sessions.get(terminal.terminalId);
    return {
      terminalId: terminal.terminalId,
      label: terminal.terminalId,
      state: "live",
      tentacleId: terminal.tentacleId,
      tentacleName: terminal.tentacleName,
      workspaceMode: terminal.workspaceMode,
      createdAt: terminal.createdAt,
      hasUserPrompt: isTerminalRecentlyActive(terminal),
      ...(terminal.parentTerminalId ? { parentTerminalId: terminal.parentTerminalId } : {}),
      ...(session ? { agentRuntimeState: session.agentState } : {}),
    };
  };

  const broadcastTerminalEvent = (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    for (const client of terminalEventClients) {
      if (client.readyState !== 1) {
        continue;
      }
      client.send(payload);
    }
  };

  const broadcastTerminalListChanged = () => {
    broadcastTerminalEvent({ type: "terminal-list-changed" });
  };

  const collectTerminalCascade = (rootTerminalId: string): string[] => {
    const toDelete = new Set<string>();
    const queue = [rootTerminalId];

    while (queue.length > 0) {
      const currentTerminalId = queue.shift();
      if (!currentTerminalId || toDelete.has(currentTerminalId)) {
        continue;
      }

      toDelete.add(currentTerminalId);
      for (const terminal of terminals.values()) {
        if (terminal.parentTerminalId === currentTerminalId) {
          queue.push(terminal.terminalId);
        }
      }
    }

    return Array.from(toDelete);
  };

  const createTerminal = ({
    terminalId: requestedTerminalId,
    tentacleId: requestedTentacleId,
    worktreeId: requestedWorktreeId,
    tentacleName,
    workspaceMode = "shared",
    agentProvider,
    initialPrompt,
    initialInputDraft,
    baseRef,
    parentTerminalId,
    nameOrigin,
    autoRenamePromptContext,
    cwdScope: requestedCwdScope,
  }: {
    terminalId?: string;
    tentacleId?: string;
    worktreeId?: string;
    tentacleName?: string;
    workspaceMode?: TentacleWorkspaceMode;
    agentProvider?: TerminalAgentProvider;
    initialPrompt?: string;
    initialInputDraft?: string;
    baseRef?: string;
    parentTerminalId?: string;
    nameOrigin?: TerminalNameOrigin;
    autoRenamePromptContext?: string;
    cwdScope?: "vault";
  }): TerminalSnapshot => {
    // Enforce max children per parent.
    if (parentTerminalId) {
      const childCount = [...terminals.values()].filter(
        (t) => t.parentTerminalId === parentTerminalId,
      ).length;
      if (childCount >= MAX_CHILDREN_PER_PARENT) {
        throw new RuntimeInputError(
          `Parent terminal "${parentTerminalId}" already has ${MAX_CHILDREN_PER_PARENT} children (limit reached).`,
        );
      }
    }

    const terminalId =
      requestedTerminalId && !terminals.has(requestedTerminalId)
        ? requestedTerminalId
        : allocateTerminalId();

    // Allow explicit tentacleId so multiple terminals can share a tentacle context (e.g. swarm workers).
    const tentacleId = requestedTentacleId ?? terminalId;
    const effectiveName = tentacleName ?? allocateDefaultTerminalName();

    // Auto-allocate a unique worktreeId when creating a worktree terminal
    // so multiple worktree terminals can coexist (each gets its own directory).
    const worktreeId =
      requestedWorktreeId ?? (workspaceMode === "worktree" ? terminalId : undefined);

    // cwdScope inheritance: if no explicit scope requested and the parent is
    // vault-scoped, inherit vault scope so entire subtrees stay anchored to
    // the vault root — that's the whole point of spawning a sub-agent.
    const parentTerminal = parentTerminalId ? terminals.get(parentTerminalId) : undefined;
    const inheritedCwdScope = parentTerminal?.cwdScope;
    const resolvedCwdScope = requestedCwdScope ?? inheritedCwdScope;

    const terminal: PersistedTerminal = {
      terminalId,
      tentacleId,
      ...(worktreeId ? { worktreeId } : {}),
      tentacleName: effectiveName,
      nameOrigin: nameOrigin ?? (tentacleName ? "user" : "generated"),
      ...(autoRenamePromptContext ? { autoRenamePromptContext } : {}),
      createdAt: new Date().toISOString(),
      workspaceMode,
      agentProvider: agentProvider ?? DEFAULT_AGENT_PROVIDER,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(initialInputDraft ? { initialInputDraft } : {}),
      ...(initialPrompt ? { lastActiveAt: new Date().toISOString() } : {}),
      ...(parentTerminalId ? { parentTerminalId } : {}),
      ...(resolvedCwdScope ? { cwdScope: resolvedCwdScope } : {}),
    };

    const effectiveWorktreeId = worktreeId ?? tentacleId;
    const shouldCreateWorktree = workspaceMode === "worktree";
    if (shouldCreateWorktree) {
      worktreeManager.createTentacleWorktree(effectiveWorktreeId, baseRef);
    }

    if (terminal.agentProvider === "claude-code") {
      // Claude hooks only apply to Claude-backed terminals. Install them in
      // the directory Claude will actually start in so they're picked up.
      try {
        const hookTargetCwd = shouldCreateWorktree
          ? worktreeManager.getTentacleWorkspaceCwd(effectiveWorktreeId)
          : resolvedCwdScope === "vault" && vaultRoot
            ? vaultRoot
            : workspaceCwd;
        hookProcessor.installHooksInDirectory(hookTargetCwd);
      } catch {
        // Best-effort: hook installation should not block terminal creation.
      }
    }

    terminals.set(terminalId, terminal);
    persistRegistry();
    broadcastTerminalEvent({
      type: "terminal-created",
      snapshot: toTerminalSnapshot(terminal),
    });

    if (initialPrompt) {
      sessionRuntime.startSession(terminalId);
    }

    return toTerminalSnapshot(terminal);
  };

  const readUiState = (): PersistedUiState => {
    const normalized = pruneUiStateTerminalReferences(uiState, terminals);
    const result: PersistedUiState = { ...normalized };
    if (normalized.minimizedTerminalIds) {
      result.minimizedTerminalIds = [...normalized.minimizedTerminalIds];
    }
    if (normalized.terminalWidths) {
      result.terminalWidths = { ...normalized.terminalWidths };
    }
    if (normalized.terminalCompletionSound !== undefined) {
      result.terminalCompletionSound = normalized.terminalCompletionSound;
    }
    return result;
  };

  return {
    listTerminalSnapshots(): TerminalSnapshot[] {
      const snapshots: TerminalSnapshot[] = [];
      for (const terminal of terminals.values()) {
        snapshots.push(toTerminalSnapshot(terminal));
      }
      return snapshots;
    },

    allocateTerminalId,

    listConversationSessions() {
      return listConversationSessions(transcriptDirectoryPath);
    },

    readConversationSession(sessionId: string) {
      return readConversationSession(transcriptDirectoryPath, sessionId);
    },

    exportConversationSession(sessionId: string, format: "json" | "md") {
      const conversation = readConversationSession(transcriptDirectoryPath, sessionId);
      if (!conversation) {
        return null;
      }

      if (format === "json") {
        const exported = {
          turns: conversation.turns,
        };
        return `${JSON.stringify(exported, null, 2)}\n`;
      }

      return conversationExportMarkdown(conversation);
    },

    deleteConversationSession(sessionId: string) {
      deleteConversation(transcriptDirectoryPath, sessionId);
    },

    deleteAllConversationSessions() {
      deleteAllConversations(transcriptDirectoryPath);
    },

    searchConversations(query: string) {
      return searchConversations(transcriptDirectoryPath, query);
    },

    // #45 Phase 3 [D9] chat create-conversation adapter. The octogent-native form of the legacy
    // dashboard Chat's `POST /` ("start a conversation bound to an agent"): create a chat session
    // bound to a tentacle terminal. Composes the pure buildCreateConversationRequest contract
    // (validation → legacy 400) over the existing createTerminal primitive, which spawns a LIVE
    // Claude Code session ([D8]) ready to receive chat turns via submitConversationMessage.
    createConversation(input: unknown): CreateConversationResult {
      let normalized: ReturnType<typeof buildCreateConversationRequest>;
      try {
        normalized = buildCreateConversationRequest((input ?? {}) as Record<string, unknown>);
      } catch (error) {
        if (error instanceof CreateConversationError) {
          return { status: "invalid", error: error.message };
        }
        throw error;
      }

      try {
        const snapshot = createTerminal({
          workspaceMode: normalized.workspaceMode,
          initialPrompt: normalized.initialPrompt,
          ...(normalized.tentacleName ? { tentacleName: normalized.tentacleName } : {}),
        });
        return {
          status: "created",
          sessionId: snapshot.terminalId,
          tentacleId: snapshot.tentacleId,
          // TerminalSnapshot types these optional, but toTerminalSnapshot always sets them; the
          // fallbacks satisfy the compiler without changing the runtime value.
          tentacleName: snapshot.tentacleName ?? snapshot.terminalId,
          workspaceMode: snapshot.workspaceMode ?? normalized.workspaceMode,
        };
      } catch (error) {
        if (error instanceof RuntimeInputError) {
          return { status: "invalid", error: error.message };
        }
        throw error;
      }
    },

    // #45 Phase 3 [D9] chat rename-conversation adapter. The octogent-native form of the legacy
    // dashboard Chat's `PUT /:id` metadata update: a session-metadata rename over the transcript
    // store (NO LLM). Validates the title via the pure buildConversationRename contract, checks the
    // conversation exists (a live terminal record OR an on-disk transcript), then persists the
    // title in the metadata sidecar — surfaced by the native GET /api/conversations/:id read.
    renameConversation(sessionId: string, title: unknown): RenameConversationResult {
      let normalized: ReturnType<typeof buildConversationRename>;
      try {
        normalized = buildConversationRename(title);
      } catch (error) {
        if (error instanceof ConversationRenameError) {
          return { status: "invalid", error: error.message };
        }
        throw error;
      }

      const exists =
        terminals.has(sessionId) ||
        readConversationSession(transcriptDirectoryPath, sessionId) !== null;
      if (!exists) {
        return { status: "no-conversation" };
      }

      writeConversationMeta(transcriptDirectoryPath, sessionId, { title: normalized.title });
      return { status: "renamed", sessionId, title: normalized.title };
    },

    // #45 Phase 3 [D9] chat conversation-title adapter. The octogent-native form of the legacy
    // dashboard Chat's generate-title + auto-title, folded into one: derive a title from the
    // conversation's first user turn (NO LLM) and PIN it in the metadata sidecar. Read-time
    // auto-derivation already surfaces a title without this call; generate PINS it so later turns
    // don't shift the displayed title. Returns no-conversation (404) when the session is unknown,
    // no-title when there is no first turn long enough to derive one yet.
    generateConversationTitle(sessionId: string): GenerateConversationTitleResult {
      const detail = readConversationSession(transcriptDirectoryPath, sessionId);
      if (!detail) {
        return { status: "no-conversation" };
      }

      const derived = deriveConversationTitle(detail.firstUserTurnPreview);
      if (!derived) {
        return { status: "no-title", sessionId };
      }

      writeConversationMeta(transcriptDirectoryPath, sessionId, { title: derived });
      return { status: "titled", sessionId, title: derived };
    },

    // #45 Phase 3 [D9] chat conversation-summary adapter. The octogent-native form of the legacy
    // dashboard Chat's `POST /:id/summarize`: a DETERMINISTIC recap over the transcript's already-
    // computed counts + previews (NO LLM). Persists the recap in the metadata sidecar (parity with
    // legacy storing conversation.summary) and returns it. 404 when the session is unknown.
    summarizeConversation(sessionId: string): SummarizeConversationResult {
      const detail = readConversationSession(transcriptDirectoryPath, sessionId);
      if (!detail) {
        return { status: "no-conversation" };
      }

      const summary = buildConversationSummaryText({
        turnCount: detail.turnCount,
        userTurnCount: detail.userTurnCount,
        assistantTurnCount: detail.assistantTurnCount,
        firstUserTurnPreview: detail.firstUserTurnPreview,
        lastUserTurnPreview: detail.lastUserTurnPreview,
        lastAssistantTurnPreview: detail.lastAssistantTurnPreview,
      });

      writeConversationMeta(transcriptDirectoryPath, sessionId, { summary });
      return { status: "summarized", sessionId, summary };
    },

    // #45 Phase 3 [D9] chat attach-document adapter — the REAL groundwork (NOT flipped to proven).
    // The octogent-native form of the legacy dashboard Chat's `POST /:id/upload`: persist the
    // upload into the tentacle's workspace (per the D9 parity note) under a conversation-scoped
    // attachments dir, and surface a transcript note when a live session exists. Validated by the
    // pure buildDocumentAttachment contract (filename sanitize + size cap).
    //
    // Honest gap (why chat-parity stays UNPROVEN): octogent has no per-conversation document store
    // — for a shared conversation the "workspace" is the whole repo root, so this writes to an
    // ad-hoc `.octogent/attachments/<sessionId>/` subdir — and nothing DELIVERS the document into
    // the live agent's context the way the legacy message-append did. See fleet/CHAT-PARITY.md.
    attachDocumentToConversation(sessionId: string, input: unknown): AttachDocumentResult {
      let normalized: ReturnType<typeof buildDocumentAttachment>;
      try {
        normalized = buildDocumentAttachment((input ?? {}) as Record<string, unknown>);
      } catch (error) {
        if (error instanceof AttachDocumentError) {
          return { status: "invalid", error: error.message };
        }
        throw error;
      }

      const exists =
        terminals.has(sessionId) ||
        readConversationSession(transcriptDirectoryPath, sessionId) !== null;
      if (!exists) {
        return { status: "no-conversation" };
      }

      // Resolve the tentacle's workspace (shared → repo root; worktree → the worktree dir). If no
      // terminal record backs the identifier, getTentacleWorkspaceCwd throws — fall back to the
      // project workspace root.
      let cwd = workspaceCwd;
      const resolved = resolveTerminalSession(sessionId);
      if (resolved) {
        try {
          cwd = worktreeManager.getTentacleWorkspaceCwd(resolved.tentacleId);
        } catch {
          cwd = workspaceCwd;
        }
      }

      const relativeDir = join(".octogent", "attachments", encodeURIComponent(sessionId));
      const absoluteDir = join(cwd, relativeDir);
      mkdirSync(absoluteDir, { recursive: true });
      writeFileSync(join(absoluteDir, normalized.safeFilename), normalized.content, "utf8");
      const relativePath = join(relativeDir, normalized.safeFilename);

      // Best-effort conversation linkage: record the attachment in the transcript when a live
      // session exists. This surfaces it in the conversation events (not as a turn — turn counts
      // come from Claude Code's Stop hook) but does NOT feed the content to the live agent.
      if (sessions.has(sessionId)) {
        conversationMessageCounter += 1;
        sessionRuntime.recordInputSubmit(
          sessionId,
          `${sessionId}:attach:${conversationMessageCounter}`,
          `[Attached document: ${normalized.safeFilename}]`,
        );
      }

      return {
        status: "attached",
        sessionId,
        filename: normalized.safeFilename,
        path: relativePath,
        byteLength: normalized.byteLength,
      };
    },

    // #45 Phase 3 [D9] chat send-message KEYSTONE adapter. Submits a chat turn into a tentacle's
    // LIVE terminal session (tentacles ARE Claude Code sessions, [D8]) with parity to the legacy
    // dashboard Chat's POST /:id/messages: content validation (400), the per-conversation
    // processing lock (409), and the input-submit into the session. The assistant reply streams
    // back through the already-native transcript surface (GET /api/conversations/:id) — Claude
    // Code's Stop hook writes the turns; no claude-client.ts in the loop.
    submitConversationMessage(
      sessionId: string,
      content: unknown,
    ): SubmitConversationMessageResult {
      const session = sessions.get(sessionId);
      const disposition = resolveSendMessageDisposition({
        present: Boolean(session),
        runtimeState: session ? session.agentState : null,
      });

      if (!session || disposition === "no-session") {
        return { status: "no-session" };
      }
      if (disposition === "busy") {
        return { status: "busy", tentacleId: session.tentacleId };
      }

      // ready — validate the turn + build the exact bracketed-paste + CR PTY submit payload.
      let submit: ReturnType<typeof buildConversationInputSubmit>;
      try {
        submit = buildConversationInputSubmit(content);
      } catch (error) {
        if (error instanceof SendMessageError) {
          return { status: "invalid-content", error: error.message };
        }
        throw error;
      }

      conversationMessageCounter += 1;
      const submitId = `${sessionId}:msg:${conversationMessageCounter}`;
      // Record the user turn in the transcript first (legacy "store user message"), then submit it
      // into the live session — writeInput flips the session to "processing", arming the B.14 lock
      // against a concurrent send until Claude Code finishes the turn.
      sessionRuntime.recordInputSubmit(sessionId, submitId, submit.text);
      const delivered = sessionRuntime.writeInput(sessionId, submit.submitPayload);
      if (!delivered) {
        return { status: "no-session" };
      }

      return {
        status: "accepted",
        submitId,
        tentacleId: session.tentacleId,
        text: submit.text,
      };
    },

    readUiState,

    patchUiState(patch: PersistedUiState): PersistedUiState {
      if (patch.activePrimaryNav !== undefined) {
        uiState.activePrimaryNav = patch.activePrimaryNav;
      }
      if (patch.isAgentsSidebarVisible !== undefined) {
        uiState.isAgentsSidebarVisible = patch.isAgentsSidebarVisible;
      }
      if (patch.sidebarWidth !== undefined) {
        uiState.sidebarWidth = patch.sidebarWidth;
      }
      if (patch.isActiveAgentsSectionExpanded !== undefined) {
        uiState.isActiveAgentsSectionExpanded = patch.isActiveAgentsSectionExpanded;
      }
      if (patch.isRuntimeStatusStripVisible !== undefined) {
        uiState.isRuntimeStatusStripVisible = patch.isRuntimeStatusStripVisible;
      }
      if (patch.isMonitorVisible !== undefined) {
        uiState.isMonitorVisible = patch.isMonitorVisible;
      }
      if (patch.isBottomTelemetryVisible !== undefined) {
        uiState.isBottomTelemetryVisible = patch.isBottomTelemetryVisible;
      }
      if (patch.isCodexUsageVisible !== undefined) {
        uiState.isCodexUsageVisible = patch.isCodexUsageVisible;
      }
      if (patch.isClaudeUsageVisible !== undefined) {
        uiState.isClaudeUsageVisible = patch.isClaudeUsageVisible;
      }
      if (patch.isClaudeUsageSectionExpanded !== undefined) {
        uiState.isClaudeUsageSectionExpanded = patch.isClaudeUsageSectionExpanded;
      }
      if (patch.isCodexUsageSectionExpanded !== undefined) {
        uiState.isCodexUsageSectionExpanded = patch.isCodexUsageSectionExpanded;
      }
      if (patch.terminalCompletionSound !== undefined) {
        uiState.terminalCompletionSound = patch.terminalCompletionSound;
      }
      if (patch.minimizedTerminalIds !== undefined) {
        uiState.minimizedTerminalIds = [...patch.minimizedTerminalIds];
      }
      if (patch.terminalWidths !== undefined) {
        uiState.terminalWidths = { ...patch.terminalWidths };
      }
      if (patch.canvasOpenTerminalIds !== undefined) {
        uiState.canvasOpenTerminalIds = [...patch.canvasOpenTerminalIds];
      }
      if (patch.canvasOpenTentacleIds !== undefined) {
        uiState.canvasOpenTentacleIds = [...patch.canvasOpenTentacleIds];
      }
      if (patch.canvasTerminalsPanelWidth !== undefined) {
        uiState.canvasTerminalsPanelWidth = patch.canvasTerminalsPanelWidth;
      }

      persistRegistry();
      return readUiState();
    },

    ...gitOps,

    createTerminal,

    renameTerminal(terminalId: string, tentacleName: string): TerminalSnapshot | null {
      const terminal = terminals.get(terminalId);
      if (!terminal) {
        return null;
      }

      terminal.tentacleName = tentacleName;
      terminal.nameOrigin = "user";
      terminal.autoRenamePromptContext = undefined;
      persistRegistry();
      broadcastTerminalEvent({
        type: "terminal-updated",
        snapshot: toTerminalSnapshot(terminal),
      });
      return toTerminalSnapshot(terminal);
    },

    deleteTerminal(terminalId: string): boolean {
      const terminal = terminals.get(terminalId);
      if (!terminal) {
        return false;
      }

      const cascadeTerminalIds = collectTerminalCascade(terminalId);
      for (const cascadeTerminalId of cascadeTerminalIds) {
        const cascadeTerminal = terminals.get(cascadeTerminalId);
        if (!cascadeTerminal) {
          continue;
        }

        sessionRuntime.closeSession(cascadeTerminalId);
        if (cascadeTerminal.workspaceMode === "worktree") {
          worktreeManager.removeTentacleWorktree(
            cascadeTerminal.worktreeId ?? cascadeTerminal.tentacleId,
          );
        }
        terminals.delete(cascadeTerminalId);
      }

      persistRegistry();
      for (const cascadeTerminalId of cascadeTerminalIds) {
        broadcastTerminalEvent({
          type: "terminal-deleted",
          terminalId: cascadeTerminalId,
        });
      }
      return true;
    },

    ...channelMessaging,

    handleHook: hookProcessor.handleHook,

    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url ?? "/", "http://localhost");
      } catch {
        return false;
      }

      if (requestUrl.pathname === "/api/terminal-events/ws") {
        terminalEventsWebsocketServer.handleUpgrade(request, socket, head, (websocket) => {
          terminalEventClients.add(websocket);
          websocket.on("close", () => {
            terminalEventClients.delete(websocket);
          });
        });
        return true;
      }

      return sessionRuntime.handleUpgrade(request, socket, head);
    },

    connectDirect(terminalId: string, listener: DirectSessionListener): (() => void) | null {
      return sessionRuntime.connectDirect(terminalId, listener);
    },

    writeInput(terminalId: string, data: string): boolean {
      return sessionRuntime.writeInput(terminalId, data);
    },

    resizeTerminal(terminalId: string, cols: number, rows: number): boolean {
      return sessionRuntime.resizeSession(terminalId, cols, rows);
    },

    async close() {
      await registryPersistence.close();
      sessionRuntime.close();
      for (const client of terminalEventClients) {
        client.close();
      }
      terminalEventClients.clear();
      terminalEventsWebsocketServer.close();
      websocketServer.close();
    },
  };
};
