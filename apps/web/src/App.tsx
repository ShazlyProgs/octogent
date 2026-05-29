import { type TerminalSnapshot, buildTerminalList, isAgentRuntimeState } from "@octogent/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { useBackendLivenessPolling } from "./app/hooks/useBackendLivenessPolling";
import { OCTOBOSS_ID } from "./app/hooks/useCanvasGraphData";
import { useClaudeUsagePolling } from "./app/hooks/useClaudeUsagePolling";
import { useCodexUsagePolling } from "./app/hooks/useCodexUsagePolling";
import { useConsoleKeyboardShortcuts } from "./app/hooks/useConsoleKeyboardShortcuts";
import { useGitHubPrimaryViewModel } from "./app/hooks/useGitHubPrimaryViewModel";
import { useGithubSummaryPolling } from "./app/hooks/useGithubSummaryPolling";
import { useInitialColumnsHydration } from "./app/hooks/useInitialColumnsHydration";
import { usePersistedUiState } from "./app/hooks/usePersistedUiState";
import { useTentacleGitLifecycle } from "./app/hooks/useTentacleGitLifecycle";
import { useTerminalCompletionNotification } from "./app/hooks/useTerminalCompletionNotification";
import { useTerminalMutations } from "./app/hooks/useTerminalMutations";
import { useTerminalStateReconciliation } from "./app/hooks/useTerminalStateReconciliation";
import { useUsageHeatmapPolling } from "./app/hooks/useUsageHeatmapPolling";
import { useWorkspaceSetup } from "./app/hooks/useWorkspaceSetup";
import {
  createTerminalRuntimeStateStore,
  getTerminalRuntimeStateInfo,
  stripTerminalRuntimeState,
  stripTerminalRuntimeStates,
} from "./app/terminalRuntimeStateStore";
import type { TerminalView } from "./app/types";
import { getBucketsById } from "./app/vault-structure";
import { clampSidebarWidth } from "./app/uiStateNormalizers";
import { ActiveAgentsSidebar } from "./components/ActiveAgentsSidebar";
import { ConsolePrimaryNav } from "./components/ConsolePrimaryNav";
import { PrimaryViewRouter } from "./components/PrimaryViewRouter";
import { RuntimeStatusStrip } from "./components/RuntimeStatusStrip";
import { SidebarActionPanel } from "./components/SidebarActionPanel";
import { HttpTerminalSnapshotReader } from "./runtime/HttpTerminalSnapshotReader";
import {
  buildTerminalEventsSocketUrl,
  buildTerminalSnapshotsUrl,
} from "./runtime/runtimeEndpoints";

export const App = () => {
  const [terminals, setTerminals] = useState<TerminalView>([]);
  const [recentlyCreatedTerminal, setRecentlyCreatedTerminal] = useState<
    TerminalView[number] | null
  >(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hoveredGitHubOverviewPointIndex, setHoveredGitHubOverviewPointIndex] = useState<
    number | null
  >(null);
  const [deckSidebarContent, setDeckSidebarContent] = useState<ReactNode>(null);
  const [conversationsSidebarContent, setConversationsSidebarContent] = useState<ReactNode>(null);
  const [conversationsActionPanel, setConversationsActionPanel] = useState<ReactNode>(null);
  const [promptsSidebarContent, setPromptsSidebarContent] = useState<ReactNode>(null);
  const terminalEventsRefreshTimerRef = useRef<number | null>(null);
  const runtimeStateStoreRef = useRef(createTerminalRuntimeStateStore());
  const runtimeStateStore = runtimeStateStoreRef.current;

  const sortTerminalSnapshots = useCallback(
    (snapshots: TerminalView) =>
      [...snapshots].sort((left, right) => {
        return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      }),
    [],
  );

  const {
    activePrimaryNav,
    setActivePrimaryNav,
    applyHydratedUiState,
    isActiveAgentsSectionExpanded,
    isAgentsSidebarVisible,
    isClaudeUsageSectionExpanded,
    isCodexUsageSectionExpanded,
    isRuntimeStatusStripVisible,
    isUiStateHydrated,
    minimizedTerminalIds,
    readUiState,
    setIsActiveAgentsSectionExpanded,
    setIsAgentsSidebarVisible,
    setIsClaudeUsageSectionExpanded,
    setIsCodexUsageSectionExpanded,
    setIsRuntimeStatusStripVisible,
    setIsUiStateHydrated,
    setMinimizedTerminalIds,
    setSidebarWidth,
    setTerminalCompletionSound,
    sidebarWidth,
    terminalCompletionSound,
    canvasOpenTerminalIds,
    setCanvasOpenTerminalIds,
    canvasOpenTentacleIds,
    setCanvasOpenTentacleIds,
    canvasTerminalsPanelWidth,
    setCanvasTerminalsPanelWidth,
  } = usePersistedUiState({ columns: terminals });
  const {
    workspaceSetup,
    isWorkspaceSetupLoading,
    workspaceSetupError,
    refreshWorkspaceSetup,
    runWorkspaceSetupStep,
  } = useWorkspaceSetup();
  const [runningWorkspaceSetupStepId, setRunningWorkspaceSetupStepId] = useState<
    | "initialize-workspace"
    | "ensure-gitignore"
    | "check-claude"
    | "check-git"
    | "check-curl"
    | "create-tentacles"
    | null
  >(null);

  const readColumns = useCallback(
    async (signal?: AbortSignal) => {
      const readerOptions: { endpoint: string; signal?: AbortSignal } = {
        endpoint: buildTerminalSnapshotsUrl(),
      };
      if (signal) {
        readerOptions.signal = signal;
      }
      const reader = new HttpTerminalSnapshotReader(readerOptions);
      const nextColumns = await buildTerminalList(reader);
      runtimeStateStore.syncFromTerminals(nextColumns);
      return stripTerminalRuntimeStates(nextColumns);
    },
    [runtimeStateStore],
  );

  const refreshColumns = useCallback(async () => {
    const nextColumns = await readColumns();
    setTerminals(nextColumns);
    return nextColumns;
  }, [readColumns]);

  const {
    clearPendingDeleteTerminal,
    confirmDeleteTerminal,
    createTerminal,
    isCreatingTerminal,
    isDeletingTerminalId,
    pendingDeleteTerminal,
    requestDeleteTerminal,
  } = useTerminalMutations({
    readColumns: async () => readColumns(),
    setColumns: setTerminals,
    setLoadError,
    setMinimizedTerminalIds,
  });

  const {
    gitStatusByTentacleId,
    gitStatusLoadingByTentacleId,
    pullRequestByTentacleId,
    pullRequestLoadingByTentacleId,
    openGitTentacleId,
    openGitTentacleStatus,
    openGitTentaclePullRequest,
    gitCommitMessageDraft,
    gitDialogError,
    isGitDialogLoading,
    isGitDialogMutating,
    setGitCommitMessageDraft,
    openTentacleGitActions,
    closeTentacleGitActions,
    commitTentacleChanges,
    commitAndPushTentacleBranch,
    pushTentacleBranch,
    syncTentacleBranch,
    mergeTentaclePullRequest,
  } = useTentacleGitLifecycle({
    columns: terminals,
  });

  useInitialColumnsHydration({
    readColumns,
    readUiState,
    applyHydratedUiState,
    setColumns: setTerminals,
    setLoadError,
    setIsLoading,
    setIsUiStateHydrated,
  });

  useEffect(() => {
    return () => {
      if (terminalEventsRefreshTimerRef.current !== null) {
        window.clearTimeout(terminalEventsRefreshTimerRef.current);
        terminalEventsRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const socket = new WebSocket(buildTerminalEventsSocketUrl());

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const payload = JSON.parse(event.data) as
          | {
              type?: unknown;
              snapshot?: TerminalSnapshot;
              terminalId?: string;
              agentRuntimeState?: string;
              toolName?: string;
            }
          | undefined;
        if (!payload || typeof payload.type !== "string") {
          return;
        }

        if (payload.type === "terminal-created" || payload.type === "terminal-updated") {
          if (!payload.snapshot) {
            return;
          }
          const runtimeState = getTerminalRuntimeStateInfo(payload.snapshot);
          runtimeStateStore.setRuntimeState(payload.snapshot.terminalId, runtimeState);
          const structuralSnapshot = stripTerminalRuntimeState(payload.snapshot);
          if (payload.type === "terminal-created") {
            setRecentlyCreatedTerminal(structuralSnapshot as TerminalView[number]);
          }
          setTerminals((current) =>
            sortTerminalSnapshots([
              ...current.filter(
                (terminal) => terminal.terminalId !== structuralSnapshot.terminalId,
              ),
              structuralSnapshot,
            ]),
          );
          return;
        }

        if (payload.type === "terminal-state-changed") {
          if (!payload.terminalId || !isAgentRuntimeState(payload.agentRuntimeState)) {
            return;
          }
          runtimeStateStore.setRuntimeState(payload.terminalId, {
            state: payload.agentRuntimeState,
            ...(payload.toolName ? { toolName: payload.toolName } : {}),
          });
          return;
        }

        if (payload.type === "terminal-deleted") {
          if (!payload.terminalId) {
            return;
          }
          runtimeStateStore.removeTerminal(payload.terminalId);
          setTerminals((current) =>
            current.filter((terminal) => terminal.terminalId !== payload.terminalId),
          );
          return;
        }

        if (payload.type !== "terminal-list-changed") {
          return;
        }
      } catch {
        return;
      }

      if (terminalEventsRefreshTimerRef.current !== null) {
        window.clearTimeout(terminalEventsRefreshTimerRef.current);
      }
      terminalEventsRefreshTimerRef.current = window.setTimeout(() => {
        terminalEventsRefreshTimerRef.current = null;
        void refreshColumns();
      }, 100);
    });

    return () => {
      if (terminalEventsRefreshTimerRef.current !== null) {
        window.clearTimeout(terminalEventsRefreshTimerRef.current);
        terminalEventsRefreshTimerRef.current = null;
      }
      socket.close();
    };
  }, [refreshColumns, runtimeStateStore, sortTerminalSnapshots]);

  const { codexUsageSnapshot, refreshCodexUsage } = useCodexUsagePolling();
  const { claudeUsageSnapshot, isRefreshingClaudeUsage, refreshClaudeUsage } =
    useClaudeUsagePolling();
  const backendLivenessStatus = useBackendLivenessPolling();
  const { githubRepoSummary, isRefreshingGitHubSummary, refreshGitHubRepoSummary } =
    useGithubSummaryPolling();
  const handleMaximizeTerminal = useCallback(
    (terminalId: string) => {
      setMinimizedTerminalIds((current) =>
        current.filter((currentTerminalId) => currentTerminalId !== terminalId),
      );
    },
    [setMinimizedTerminalIds],
  );
  const handleActiveTerminalIdsChange = useCallback(
    (activeTerminalIds: ReadonlySet<string>) => {
      runtimeStateStore.retainTerminalIds(activeTerminalIds);
    },
    [runtimeStateStore],
  );

  useTerminalStateReconciliation({
    columns: terminals,
    setMinimizedTerminalIds,
    onActiveTerminalIdsChange: handleActiveTerminalIdsChange,
  });
  const { playCompletionSoundPreview } = useTerminalCompletionNotification(
    runtimeStateStore,
    terminalCompletionSound,
  );
  const { heatmapData, isLoadingHeatmap, refreshHeatmap } = useUsageHeatmapPolling({
    enabled: isUiStateHydrated && (activePrimaryNav === 3 || isRuntimeStatusStripVisible),
  });

  useConsoleKeyboardShortcuts({ setActivePrimaryNav });

  const {
    githubCommitCount30d,
    sparklinePoints,
    githubOverviewGraphSeries,
    githubOverviewGraphPolylinePoints,
    githubOverviewHoverLabel,
    githubStatusPill,
    githubRepoLabel,
    githubStarCountLabel,
    githubOpenIssuesLabel,
    githubOpenPrsLabel,
    githubRecentCommits,
  } = useGitHubPrimaryViewModel({
    githubRepoSummary,
    hoveredGitHubOverviewPointIndex,
    setHoveredGitHubOverviewPointIndex,
  });
  const hasSidebarActionPanel =
    conversationsActionPanel !== null ||
    pendingDeleteTerminal !== null ||
    (openGitTentacleId !== null &&
      terminals.find((terminal) => terminal.tentacleId === openGitTentacleId)?.workspaceMode ===
        "worktree");

  const sidebarActionPanel = hasSidebarActionPanel ? (
    conversationsActionPanel ? (
      <>{conversationsActionPanel}</>
    ) : (
      <SidebarActionPanel
        pendingDeleteTerminal={pendingDeleteTerminal}
        isDeletingTerminalId={isDeletingTerminalId}
        clearPendingDeleteTerminal={clearPendingDeleteTerminal}
        confirmDeleteTerminal={confirmDeleteTerminal}
        openGitTentacleId={openGitTentacleId}
        columns={terminals}
        openGitTentacleStatus={openGitTentacleStatus}
        openGitTentaclePullRequest={openGitTentaclePullRequest}
        gitCommitMessageDraft={gitCommitMessageDraft}
        gitDialogError={gitDialogError}
        isGitDialogLoading={isGitDialogLoading}
        isGitDialogMutating={isGitDialogMutating}
        setGitCommitMessageDraft={setGitCommitMessageDraft}
        closeTentacleGitActions={closeTentacleGitActions}
        commitTentacleChanges={commitTentacleChanges}
        commitAndPushTentacleBranch={commitAndPushTentacleBranch}
        pushTentacleBranch={pushTentacleBranch}
        syncTentacleBranch={syncTentacleBranch}
        mergeTentaclePullRequest={mergeTentaclePullRequest}
        requestDeleteTerminal={requestDeleteTerminal}
      />
    )
  ) : null;

  useEffect(() => {
    if (!hasSidebarActionPanel || isAgentsSidebarVisible) {
      return;
    }
    setIsAgentsSidebarVisible(true);
  }, [isAgentsSidebarVisible, setIsAgentsSidebarVisible, hasSidebarActionPanel]);

  const handleTerminalRenamed = useCallback((terminalId: string, tentacleName: string) => {
    setTerminals((current) =>
      current.map((t) =>
        t.terminalId === terminalId ? { ...t, tentacleName, label: tentacleName } : t,
      ),
    );
  }, []);

  const handleTerminalActivity = useCallback((terminalId: string) => {
    setTerminals((current) =>
      current.map((t) => (t.terminalId === terminalId ? { ...t, hasUserPrompt: true } : t)),
    );
  }, []);

  const handleRunWorkspaceSetupStep = useCallback(
    async (
      stepId:
        | "initialize-workspace"
        | "ensure-gitignore"
        | "check-claude"
        | "check-git"
        | "check-curl"
        | "create-tentacles",
    ) => {
      setRunningWorkspaceSetupStepId(stepId);
      try {
        await runWorkspaceSetupStep(stepId);
      } finally {
        setRunningWorkspaceSetupStepId(null);
      }
    },
    [runWorkspaceSetupStep],
  );

  return (
    <div className="page console-shell">
      {isRuntimeStatusStripVisible && (
        <RuntimeStatusStrip
          sparklinePoints={sparklinePoints}
          usageData={heatmapData}
          claudeUsage={claudeUsageSnapshot}
          isRefreshingClaudeUsage={isRefreshingClaudeUsage}
          onRefreshClaudeUsage={refreshClaudeUsage}
        />
      )}

      <ConsolePrimaryNav
        activePrimaryNav={activePrimaryNav}
        onPrimaryNavChange={setActivePrimaryNav}
      />

      <section className="console-main-canvas" aria-label="Main content canvas">
        <div
          className={`workspace-shell${isAgentsSidebarVisible && activePrimaryNav !== 1 && activePrimaryNav !== 3 && activePrimaryNav !== 4 && activePrimaryNav !== 7 ? "" : " workspace-shell--full"}`}
        >
          {isAgentsSidebarVisible &&
            activePrimaryNav !== 1 &&
            activePrimaryNav !== 3 &&
            activePrimaryNav !== 4 &&
            activePrimaryNav !== 7 && (
              <ActiveAgentsSidebar
                sidebarWidth={sidebarWidth}
                onSidebarWidthChange={(width) => {
                  setSidebarWidth(clampSidebarWidth(width));
                }}
                actionPanel={sidebarActionPanel}
                bodyContent={
                  activePrimaryNav === 2
                    ? (deckSidebarContent ?? undefined)
                    : activePrimaryNav === 5
                      ? (conversationsSidebarContent ?? undefined)
                      : activePrimaryNav === 6
                        ? (promptsSidebarContent ?? undefined)
                        : undefined
                }
              />
            )}

          <PrimaryViewRouter
            activePrimaryNav={activePrimaryNav}
            deckPrimaryViewProps={{
              onSidebarContent: setDeckSidebarContent,
              workspaceSetup,
              isWorkspaceSetupLoading,
              workspaceSetupError,
              onRefreshWorkspaceSetup: refreshWorkspaceSetup,
              onRunWorkspaceSetupStep: runWorkspaceSetupStep,
              suppressWorkspaceSetupCard: true,
            }}
            activityPrimaryViewProps={{
              usageChartProps: {
                data: heatmapData,
                isLoading: isLoadingHeatmap,
                onRefresh: refreshHeatmap,
              },
              githubPrimaryViewProps: {
                githubCommitCount30d,
                githubOpenIssuesLabel,
                githubOpenPrsLabel,
                githubRecentCommits,
                githubOverviewGraphPolylinePoints,
                githubOverviewGraphSeries,
                githubOverviewHoverLabel,
                githubRepoLabel,
                githubStarCountLabel,
                githubStatusPill,
                hoveredGitHubOverviewPointIndex,
                isRefreshingGitHubSummary,
                onHoveredGitHubOverviewPointIndexChange: setHoveredGitHubOverviewPointIndex,
                onRefresh: () => {
                  void refreshGitHubRepoSummary();
                },
              },
            }}
            settingsPrimaryViewProps={{
              isRuntimeStatusStripVisible,
              onRuntimeStatusStripVisibilityChange: setIsRuntimeStatusStripVisible,
              onPreviewTerminalCompletionSound: playCompletionSoundPreview,
              onTerminalCompletionSoundChange: setTerminalCompletionSound,
              terminalCompletionSound,
            }}
            canvasPrimaryViewProps={{
              columns: terminals,
              runtimeStateStore,
              isUiStateHydrated,
              recentlyCreatedTerminal,
              canvasOpenTerminalIds,
              canvasOpenTentacleIds,
              canvasTerminalsPanelWidth,
              workspaceSetup,
              isWorkspaceSetupLoading,
              workspaceSetupError,
              runningWorkspaceSetupStepId,
              onRunWorkspaceSetupStep: handleRunWorkspaceSetupStep,
              onLaunchWorkspaceSetupPlanner: async () => {
                const response = await fetch("/api/terminals", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: "tentacle-planner",
                    workspaceMode: "shared",
                    agentProvider: "claude-code",
                    promptTemplate: "tentacle-planner",
                  }),
                });
                if (!response.ok) {
                  return undefined;
                }
                const snapshot = (await response.json()) as { terminalId?: string };
                await refreshColumns();
                if (typeof snapshot.terminalId !== "string") {
                  return undefined;
                }
                return snapshot.terminalId;
              },
              onCanvasOpenTerminalIdsChange: setCanvasOpenTerminalIds,
              onCanvasOpenTentacleIdsChange: setCanvasOpenTentacleIds,
              onCanvasTerminalsPanelWidthChange: setCanvasTerminalsPanelWidth,
              onCreateAgent: async (tentacleId) => {
                return await createTerminal("shared", undefined, tentacleId);
              },
              onCreateTerminal: async () => {
                return await createTerminal("shared", undefined, OCTOBOSS_ID);
              },
              onCreateWorktreeTerminal: async () => {
                return await createTerminal("worktree", undefined, OCTOBOSS_ID);
              },
              onCreateTentacle: async () => {
                const response = await fetch("/api/deck/tentacles", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: "", description: "" }),
                });
                if (!response.ok) return;
                await refreshColumns();
              },
              onCreateVaultAgent: async () => {
                // Idempotent: ensure the vaultagent tentacle exists, then spawn terminal
                try {
                  await fetch("/api/deck/tentacles", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name: "vaultagent",
                      description: "VaultAgent — vault specialist",
                    }),
                  });
                } catch {
                  // tentacle may already exist; ignore
                }
                const response = await fetch("/api/terminals", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: "VaultAgent",
                    workspaceMode: "shared",
                    tentacleId: "vaultagent",
                    cwdScope: "vault",
                    promptTemplate: "vault-agent-init",
                  }),
                });
                if (!response.ok) {
                  let detail = response.statusText;
                  try {
                    const body = (await response.json()) as { error?: unknown };
                    if (typeof body?.error === "string" && body.error.length > 0) {
                      detail = body.error;
                    }
                  } catch {
                    // not JSON
                  }
                  console.error(
                    `[octogent] Create VaultAgent failed: ${response.status} ${detail}`,
                  );
                  window.alert(
                    `Create VaultAgent failed (${response.status}):\n\n${detail}`,
                  );
                  return;
                }
                await refreshColumns();
              },
              onSummonSubAgent: async (
                parentTerminalId,
                buckets,
                displayName,
                purpose,
                promptTemplate,
                skipInitialPrompt,
              ) => {
                // Generate a slug from display name
                const slug = displayName
                  .toLowerCase()
                  .replace(/\+/g, "-")
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "");
                if (!slug) {
                  window.alert("Invalid name — cannot derive a slug");
                  return;
                }
                // Ensure tentacle exists
                try {
                  await fetch("/api/deck/tentacles", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name: slug,
                      description: `${displayName} — scope: ${buckets.join(", ")}`,
                    }),
                  });
                } catch {
                  // tentacle may already exist; ignore
                }
                // Build scope block descriptions from the buckets
                // (frontend mirror of VAULT-STRUCTURE.md — minimal for prompt variables)
                // promptTemplate defaults to vault-subagent-init but presets may override
                // (e.g. VaultSyncAgent → vaultsync-agent-init). Variables are a superset;
                // unknown {{placeholders}} are left as-is by the interpolator, so this is safe.
                // Build the POST body. For general-purpose agents
                // (skipInitialPrompt), send no promptTemplate / variables —
                // the spawned Claude gets a vanilla boot keyed to cwd, just
                // like opening Claude Code directly in that directory.
                const postBody: Record<string, unknown> = {
                  name: displayName,
                  workspaceMode: "shared",
                  tentacleId: slug,
                  parentTerminalId: parentTerminalId || undefined,
                  // Vault sub-agents spawn with cwd=vault root so they
                  // inherit Mohamed's auto-memory + claude-mem + CLAUDE.md
                  // chain. Without this they'd boot into octogent's empty
                  // project slug and lose all prior context.
                  cwdScope: "vault",
                };
                if (!skipInitialPrompt) {
                  postBody.promptTemplate = promptTemplate || "vault-subagent-init";
                  postBody.promptVariables = (() => {
                      // Resolve the concrete memory-file set for the selected
                      // buckets (mirrors $VAULT/.shazly/VAULT-STRUCTURE.md).
                      // This replaces the previous hand-wave that pointed
                      // sub-agents at the whole structure doc.
                      const bucketObjs = getBucketsById(buckets);
                      const memoryFiles = Array.from(
                        new Set(
                          bucketObjs.flatMap((b) => b.memoryFiles ?? []),
                        ),
                      );
                      const memoryBlock = memoryFiles.length > 0
                        ? memoryFiles
                            .map(
                              (f) =>
                                `- ~/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/${f}`,
                            )
                            .join("\n")
                        : "(no priority memory files for selected buckets — read MEMORY.md index for overview)";
                      const pathsBlock = bucketObjs.length > 0
                        ? bucketObjs
                            .flatMap((b) => b.paths.map((p) => `- ${p}`))
                            .join("\n")
                        : "(no paths resolved — read $VAULT/.shazly/VAULT-STRUCTURE.md)";
                      return {
                        displayName,
                        bucketsList: buckets.join(", "),
                        pathsBlock,
                        pathsOneLine: buckets.join("+"),
                        purposeBlock: purpose || "(no specific directive — VaultAgent will instruct you)",
                        purposeOneLine: purpose || "(unspecified)",
                        memoryFilesBlock: memoryBlock,
                        memoryFilesList: memoryFiles.join(", ") || "(none)",
                        memoryFilesCount: String(memoryFiles.length),
                        parentTerminalId: parentTerminalId || "(none)",
                      };
                    })();
                }
                const response = await fetch("/api/terminals", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(postBody),
                });
                if (!response.ok) {
                  let detail = response.statusText;
                  try {
                    const body = (await response.json()) as { error?: unknown };
                    if (typeof body?.error === "string" && body.error.length > 0) {
                      detail = body.error;
                    }
                  } catch {}
                  console.error(
                    `[octogent] Summon Sub-Agent failed: ${response.status} ${detail}`,
                  );
                  window.alert(`Summon Sub-Agent failed (${response.status}):\n\n${detail}`);
                  return;
                }
                await refreshColumns();
              },
              onCreateGenericAgent: async () => {
                const raw = window.prompt(
                  "Agent name? (used as tentacle id + display)",
                  "",
                );
                if (raw === null) return;
                const name = raw.trim();
                if (name.length === 0) return;
                try {
                  await fetch("/api/deck/tentacles", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name,
                      description: `Generic agent: ${name}`,
                    }),
                  });
                } catch {
                  // tentacle may already exist; ignore
                }
                const response = await fetch("/api/terminals", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name,
                    workspaceMode: "shared",
                    tentacleId: name,
                  }),
                });
                if (!response.ok) {
                  let detail = response.statusText;
                  try {
                    const body = (await response.json()) as { error?: unknown };
                    if (typeof body?.error === "string" && body.error.length > 0) {
                      detail = body.error;
                    }
                  } catch {
                    // not JSON
                  }
                  console.error(
                    `[octogent] Create Agent failed: ${response.status} ${detail}`,
                  );
                  window.alert(
                    `Create Agent failed (${response.status}):\n\n${detail}`,
                  );
                  return;
                }
                await refreshColumns();
              },
              onTentacleAction: async (tentacleId, action) => {
                const response = await fetch("/api/terminals", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    workspaceMode: "shared",
                    tentacleId,
                    promptTemplate: action,
                    promptVariables: {
                      tentacleId,
                    },
                  }),
                });
                if (!response.ok) return undefined;
                const snapshot = (await response.json()) as { terminalId?: string };
                await refreshColumns();
                return typeof snapshot.terminalId === "string" ? snapshot.terminalId : undefined;
              },
              onNavigateToConversation: (_sessionId) => {
                setActivePrimaryNav(5);
              },
              onDeleteActiveSession: (terminalId, terminalName, workspaceMode) => {
                requestDeleteTerminal(terminalId, terminalName, {
                  workspaceMode: workspaceMode === "worktree" ? "worktree" : "shared",
                  intent: "delete-terminal",
                });
              },
              pendingDeleteTerminal,
              isDeletingTerminalId,
              onCancelDelete: clearPendingDeleteTerminal,
              onConfirmDelete: () => {
                void confirmDeleteTerminal();
              },
              onTerminalRenamed: handleTerminalRenamed,
              onTerminalActivity: handleTerminalActivity,
              onRefreshColumns: async () => {
                await refreshColumns();
              },
            }}
            conversationsEnabled={isUiStateHydrated && activePrimaryNav === 5}
            onConversationsSidebarContent={setConversationsSidebarContent}
            onConversationsActionPanel={setConversationsActionPanel}
            promptsEnabled={isUiStateHydrated && activePrimaryNav === 6}
            onPromptsSidebarContent={setPromptsSidebarContent}
          />
        </div>
      </section>

    </div>
  );
};
