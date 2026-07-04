import type { UsageChartResponse } from "../claudeSessionScanner";
import type { ClaudeUsageSnapshot } from "../claudeUsage";
import type { CodexUsageSnapshot } from "../codexUsage";
import type { GitHubRepoSummarySnapshot } from "../githubRepoSummary";
import type { MonitorService } from "../monitor";
import type { GitClient } from "../terminalRuntime";

export type CreateApiServerOptions = {
  workspaceCwd?: string | undefined;
  projectStateDir?: string | undefined;
  promptsDir?: string | undefined;
  webDistDir?: string | undefined;
  apiBaseUrl?: string | undefined;
  gitClient?: GitClient;
  readClaudeUsageSnapshot?: () => Promise<ClaudeUsageSnapshot>;
  readClaudeOauthUsageSnapshot?: () => Promise<ClaudeUsageSnapshot>;
  readClaudeCliUsageSnapshot?: () => Promise<ClaudeUsageSnapshot>;
  readCodexUsageSnapshot?: () => Promise<CodexUsageSnapshot>;
  readGithubRepoSummary?: () => Promise<GitHubRepoSummarySnapshot>;
  scanUsageHeatmap?: (scope: "all" | "project") => Promise<UsageChartResponse>;
  monitorService?: MonitorService;
  invalidateClaudeUsageCache?: () => void;
  allowRemoteAccess?: boolean;
  /**
   * OCT-01 hardening. When set, mutating requests (POST/PUT/PATCH/DELETE) must
   * present this token via `Authorization: Bearer` or `X-Api-Key`. Unset (the
   * default) preserves the loopback-open behaviour the live fleet relies on.
   */
  apiToken?: string | undefined;
};
