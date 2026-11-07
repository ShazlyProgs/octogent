import type { AgentRuntimeState } from "./agentRuntime";

export type AgentState = "live" | "idle" | "queued" | "blocked";
export type TentacleWorkspaceMode = "shared" | "worktree";

export type TerminalSnapshot = {
  terminalId: string;
  label: string;
  state: AgentState;
  tentacleId: string;
  tentacleName?: string;
  workspaceMode?: TentacleWorkspaceMode;
  createdAt: string;
  hasUserPrompt?: boolean;
  parentTerminalId?: string;
  metadata?: Record<string, string>;
  agentRuntimeState?: AgentRuntimeState;
  /** P33: Enter retry failed; input line is dirty. Guarded delivery refuses until the flag clears. */
  deliveryBlocked?: boolean;
  deliveryBlockedReason?: string;
  /** P27 (OCTO_LOG_TRUTH=1): where the state came from and how old it is. */
  stateSource?: "log" | "notify" | "pty";
  stateAgeSec?: number | null;
  logTruth?: {
    mode: "off" | "shadow" | "gate";
    logState: string;
    stateSource: "log" | "notify" | "pty";
    stateAgeSec: number | null;
    legacyState: string;
    ui?: boolean;
  };
};
