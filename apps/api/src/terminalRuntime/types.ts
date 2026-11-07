import type { WriteStream } from "node:fs";

import type {
  ChannelMessage,
  PersistedUiState,
  TentacleGitStatusSnapshot,
  TentaclePullRequestSnapshot,
  TentacleWorkspaceMode,
  TerminalAgentProvider,
} from "@octogent/core";
import { isTerminalAgentProvider, isTerminalCompletionSoundId } from "@octogent/core";
import type { IPty } from "node-pty";
import type { WebSocket } from "ws";

import type { AgentRuntimeState, AgentStateTracker } from "../agentStateDetection";

export type TerminalStateMessage = {
  type: "state";
  state: AgentRuntimeState;
  toolName?: string;
};

export type TerminalOutputMessage = {
  type: "output";
  data: string;
};

export type TerminalHistoryMessage = {
  type: "history";
  data: string;
};

export type TerminalRenameMessage = {
  type: "rename";
  tentacleName: string;
};

export type TerminalActivityMessage = {
  type: "activity";
};

export type TerminalServerMessage =
  | TerminalStateMessage
  | TerminalOutputMessage
  | TerminalHistoryMessage
  | TerminalRenameMessage
  | TerminalActivityMessage;

export type DirectSessionListener = (message: TerminalServerMessage) => void;

export type TerminalSession = {
  terminalId: string;
  tentacleId: string;
  pty: IPty;
  clients: Set<WebSocket>;
  directListeners: Set<DirectSessionListener>;
  cols: number;
  rows: number;
  agentState: AgentRuntimeState;
  stateTracker: AgentStateTracker;
  isBootstrapCommandSent: boolean;
  scrollbackChunks: string[];
  scrollbackBytes: number;
  statePollTimer?: ReturnType<typeof setInterval> | undefined;
  idleCloseTimer?: ReturnType<typeof setTimeout> | undefined;
  debugLog?: WriteStream;
  transcriptLog?: WriteStream | undefined;
  transcriptEventCount?: number;
  pendingInput?: string;
  hasTranscriptEnded?: boolean;
  initialPrompt?: string;
  isInitialPromptSent?: boolean;
  initialInputDraft?: string;
  isInitialInputDraftSent?: boolean;
  keepAliveWithoutClients?: boolean;
  /** One-session provider selected by an explicit wake request; never persisted to the terminal record. */
  agentProviderOverride?: TerminalAgentProvider;
  hasSeenProcessing?: boolean;
  lastToolName?: string | undefined;
  bootstrapAt?: number;
  lastPtyOutputAt?: number;
  initialPromptPollTimer?: ReturnType<typeof setInterval> | undefined;
  /** P33 */
  p33bTyped?: { at: number; text: string };
  p33Pending?: {
    at: number;
    text: string;
    turnId?: string;
    source?: "typed";
    retried?: boolean;
    timer?: ReturnType<typeof setTimeout> | undefined;
  };
  deliveryBlocked?: { reason: string; at: string; text?: string };
  blockedDeliveryCount?: number;
  pendingComposerSubmit?: boolean;
  claudeTurnPending?: boolean;
  codexProviderThreadId?: string;
  codexResumeThreadId?: string;
  claudeResumeSessionId?: string;
};

export type TerminalNameOrigin = "generated" | "user" | "prompt";

export {
  type ChannelMessage,
  type PersistedUiState,
  type TentacleGitStatusSnapshot,
  type TentaclePullRequestSnapshot,
  type TentacleWorkspaceMode,
  type TerminalAgentProvider,
  isTerminalAgentProvider,
  isTerminalCompletionSoundId,
};

export type PersistedTerminal = {
  terminalId: string;
  tentacleId: string;
  worktreeId?: string;
  tentacleName: string;
  nameOrigin?: TerminalNameOrigin;
  autoRenamePromptContext?: string | undefined;
  createdAt: string;
  workspaceMode: TentacleWorkspaceMode;
  agentProvider?: TerminalAgentProvider;
  /** Last authenticated Codex thread reported by the provider lifecycle bridge. */
  codexThreadId?: string;
  /** Operator-recorded Claude Code session id used by resumeTerminal for claude-code seats. */
  claudeSessionId?: string;
  /** P42: prior provider session ids archived on a fresh start (audit / restore). */
  previousSessionIds?: Array<{ at: string; codexThreadId?: string; claudeSessionId?: string }>;
  initialPrompt?: string;
  initialInputDraft?: string;
  lastActiveAt?: string;
  startedAt?: string;
  parentTerminalId?: string;
  /** String-only durable metadata for registered profile/service identities. */
  metadata?: Record<string, string>;
  /**
   * Optional cwd scope override for the spawned Claude process.
   * "vault" → cwd = detected vault root (restores auto-memory + claude-mem
   *           + CLAUDE.md chain + governance hooks parity with Mohamed's
   *           pre-octogent Claude Code experience).
   * undefined → fall back to worktree path (worktree mode) or workspaceCwd.
   */
  cwdScope?: "vault";
};

export type GitClientPullRequestSnapshot = Omit<
  TentaclePullRequestSnapshot,
  "tentacleId" | "workspaceMode" | "status"
> & {
  state: "OPEN" | "MERGED" | "CLOSED";
};

export type TerminalRegistryDocument = {
  version: 3;
  terminals: PersistedTerminal[];
  uiState?: PersistedUiState;
};

export type GitClient = {
  assertAvailable(): void;
  isRepository(cwd: string): boolean;
  addWorktree(options: { cwd: string; path: string; branchName: string; baseRef: string }): void;
  removeWorktree(options: { cwd: string; path: string }): void;
  removeBranch(options: { cwd: string; branchName: string }): void;
  readWorktreeStatus(options: {
    cwd: string;
  }): Omit<TentacleGitStatusSnapshot, "tentacleId" | "workspaceMode">;
  commitAll(options: { cwd: string; message: string }): void;
  pushCurrentBranch(options: { cwd: string }): void;
  syncWithBase(options: { cwd: string; baseRef: string }): void;
  readCurrentBranchPullRequest(options: {
    cwd: string;
  }): GitClientPullRequestSnapshot | null;
  createPullRequest(options: {
    cwd: string;
    title: string;
    body: string;
    baseRef: string;
    headRef: string;
  }): GitClientPullRequestSnapshot | null;
  mergeCurrentBranchPullRequest(options: {
    cwd: string;
    strategy: "squash" | "merge" | "rebase";
  }): void;
};

export class RuntimeInputError extends Error {}

export type CreateTerminalRuntimeOptions = {
  workspaceCwd: string;
  projectStateDir?: string | undefined;
  gitClient?: GitClient;
  getApiBaseUrl?: () => string;
};
