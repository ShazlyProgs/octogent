import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";

import {
  BackOfficeToolError,
  type EvidenceItem,
  VERIFY_VERDICT_JSON_SCHEMA,
  VerifyHarnessError,
  type WorkProductDescriptor,
  buildVerifyPrompt,
  findBackOfficeTool,
  getBackOfficeToolDefinitions,
  getChatParityCapabilities,
  summarizeChatParity,
  toBackOfficeInputSchema,
} from "@octogent/core";
import {
  BackOfficeConfigError,
  executeBackOfficeTool,
  resolveBackOfficeConfigFromEnv,
} from "./backOfficeClient";
import { readApiToken } from "./createApiServer/security";
import {
  ensureOctogentGitignoreEntry,
  ensureProjectScaffold,
  loadProjectConfig,
  loadProjectsRegistry,
  migrateStateToGlobal,
  registerProject,
  resolveEphemeralProjectStateDir,
  resolveProjectStateDir,
} from "./projectPersistence";
import { clearRuntimeMetadata, readRuntimeMetadata, writeRuntimeMetadata } from "./runtimeMetadata";
import {
  collectStartupPrerequisiteReport,
  formatStartupPrerequisiteReport,
} from "./startupPrerequisites";

const args = process.argv.slice(2);
const command = args[0];

const resolvePackageRoot = () => {
  const envRoot = process.env.OCTOGENT_PACKAGE_ROOT?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }

  const candidates = [
    resolve(import.meta.dirname ?? ".", "../.."),
    resolve(import.meta.dirname ?? ".", "../../.."),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return candidates[0] ?? process.cwd();
};

const PACKAGE_ROOT = resolvePackageRoot();

const resolveRuntimeAssetPath = (...relativePathCandidates: [string[], ...string[][]]) => {
  for (const relativePath of relativePathCandidates) {
    const candidate = join(PACKAGE_ROOT, ...relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return join(PACKAGE_ROOT, ...relativePathCandidates[0]);
};

const DEFAULT_START_PORT = 8787;
const MAX_PORT_ATTEMPTS = 200;

const initializeProject = (workspaceCwd: string, preferredName?: string) => {
  const projectName = preferredName?.trim() || basename(workspaceCwd) || "octogent-project";
  const hadConfig = loadProjectConfig(workspaceCwd) !== null;
  const projectConfig = ensureProjectScaffold(workspaceCwd, projectName);
  ensureOctogentGitignoreEntry(workspaceCwd);
  registerProject(workspaceCwd, projectConfig.displayName);
  const projectStateDir = resolveProjectStateDir(workspaceCwd, projectConfig.displayName);
  migrateStateToGlobal(workspaceCwd, projectStateDir);
  return {
    created: !hadConfig,
    projectConfig,
    projectStateDir,
  };
};

const resolveStartupProjectContext = (workspaceCwd: string) => {
  const existingConfig = loadProjectConfig(workspaceCwd);
  if (existingConfig) {
    registerProject(workspaceCwd, existingConfig.displayName);
    const projectStateDir = resolveProjectStateDir(workspaceCwd, existingConfig.displayName);
    migrateStateToGlobal(workspaceCwd, projectStateDir);
    return {
      isInitialized: true,
      projectDisplayName: existingConfig.displayName,
      projectStateDir,
    };
  }

  const projectDisplayName = basename(workspaceCwd) || "octogent-project";
  const projectStateDir = resolveEphemeralProjectStateDir(workspaceCwd);
  return {
    isInitialized: false,
    projectDisplayName,
    projectStateDir,
  };
};

const initProject = (name?: string) => {
  const projectPath = process.cwd();
  const { created, projectConfig, projectStateDir } = initializeProject(projectPath, name);

  console.log(
    `${created ? "Initialized" : "Updated"} Octogent project "${projectConfig.displayName}" at ${projectPath}`,
  );
  console.log("  .octogent/ directory ready (project metadata, tentacles, worktrees)");
  console.log(`  Global state: ${projectStateDir}`);
  console.log("  .gitignore updated");
  console.log("\nRun `octogent` to start the dashboard.");
};

const canListenOnPort = (port: number): Promise<boolean> =>
  new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, "127.0.0.1");
  });

const findOpenPort = async (startPort: number): Promise<number> => {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    if (await canListenOnPort(port)) {
      return port;
    }
  }

  throw new Error(`Unable to find an open port starting from ${startPort}`);
};

const readPreferredStartPort = () => {
  const rawPort = process.env.OCTOGENT_API_PORT ?? process.env.PORT;
  if (!rawPort) {
    return DEFAULT_START_PORT;
  }

  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_START_PORT;
  }

  return parsed;
};

const resolveRuntimeApiBase = () => {
  const explicitBase =
    process.env.OCTOGENT_API_ORIGIN?.trim() || process.env.OCTOGENT_API_BASE?.trim();
  if (explicitBase) {
    return explicitBase;
  }

  const projectConfig = loadProjectConfig(process.cwd());
  if (projectConfig) {
    const projectStateDir = resolveProjectStateDir(process.cwd(), projectConfig.displayName);
    const runtimeMetadata = readRuntimeMetadata(projectStateDir);
    if (runtimeMetadata) {
      return runtimeMetadata.apiBaseUrl;
    }
  }

  return `http://127.0.0.1:${readPreferredStartPort()}`;
};

const apiError = () => {
  console.error(
    `Error: Could not reach API at ${resolveRuntimeApiBase()}. Start Octogent in this project first.`,
  );
  process.exit(1);
};

// OCT-01: when OCTOGENT_API_TOKEN is set, the CLI must present it on mutating
// requests (the API gates POST/PUT/PATCH/DELETE). Unset → no header, unchanged.
const apiAuthHeaders = (): Record<string, string> => {
  const token = readApiToken(process.env.OCTOGENT_API_TOKEN);
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const maybeOpenBrowser = (url: string) => {
  if (process.env.OCTOGENT_NO_OPEN === "1" || process.env.CI === "1") {
    return;
  }

  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // Best-effort browser open.
  }
};

const startServer = async () => {
  const startupPrerequisiteReport = collectStartupPrerequisiteReport();
  const startupPrerequisiteLines = formatStartupPrerequisiteReport(startupPrerequisiteReport);
  if (startupPrerequisiteLines.length > 0) {
    for (const line of startupPrerequisiteLines) {
      if (startupPrerequisiteReport.errors.length > 0) {
        console.error(line);
      } else {
        console.warn(line);
      }
    }
    if (startupPrerequisiteReport.errors.length > 0) {
      process.exit(1);
    }
    console.warn("");
  }

  const workspaceCwd = process.cwd();
  const { isInitialized, projectDisplayName, projectStateDir } =
    resolveStartupProjectContext(workspaceCwd);
  const promptsDir = resolveRuntimeAssetPath(["dist", "prompts"], ["prompts"]);
  const webDistDir = resolveRuntimeAssetPath(["dist", "web"], ["apps", "web", "dist"]);
  const port = await findOpenPort(readPreferredStartPort());
  const { detectVaultRoot } = await import("./terminalRuntime/vaultRoot");
  const vaultRoot = detectVaultRoot(workspaceCwd);
  const { createApiServer } = await import("./createApiServer");

  const apiServer = createApiServer({
    workspaceCwd,
    projectStateDir,
    promptsDir,
    webDistDir: existsSync(webDistDir) ? webDistDir : undefined,
    allowRemoteAccess: process.env.OCTOGENT_ALLOW_REMOTE_ACCESS === "1",
    // OCT-01: optional token gate for mutating endpoints (unset = loopback-open).
    apiToken: readApiToken(process.env.OCTOGENT_API_TOKEN),
    ...(vaultRoot ? { vaultRoot } : {}),
  });

  const shutdown = async () => {
    clearRuntimeMetadata(projectStateDir);
    await apiServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const { host, port: activePort } = await apiServer.start(port, "127.0.0.1");
  const apiBaseUrl = `http://${host}:${activePort}`;
  writeRuntimeMetadata(projectStateDir, {
    apiBaseUrl,
    host,
    port: activePort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workspaceCwd,
  });

  const hasWebDist = existsSync(webDistDir);
  if (hasWebDist) {
    maybeOpenBrowser(apiBaseUrl);
  }

  console.log();
  console.log("  Octogent is running");
  console.log(`  Project: ${workspaceCwd}`);
  console.log(`  Name:    ${projectDisplayName}`);
  console.log(`  API:     ${apiBaseUrl}`);
  if (hasWebDist) {
    console.log(`  UI:      ${apiBaseUrl}`);
  } else {
    console.log("  UI:      bundled web assets are missing from this install");
  }
  if (!isInitialized) {
    console.log("  Setup:   workspace is not initialized yet; use the in-app setup flow");
  }
  console.log();
};

const COLORS = [
  "#ff6b2b",
  "#ff2d6b",
  "#00ffaa",
  "#bf5fff",
  "#00c8ff",
  "#ffee00",
  "#39ff14",
  "#ff4df0",
  "#00fff7",
  "#ff9500",
];
const ANIMATIONS = ["sway", "walk", "jog", "bounce", "float", "swim-up"];
const EXPRESSIONS = ["normal", "happy", "angry", "surprised"];
const ACCESSORIES = ["none", "none", "long", "mohawk", "side-sweep", "curly"];
const HAIR_COLORS = [
  "#4a2c0a",
  "#1a1a1a",
  "#c8a04a",
  "#e04020",
  "#f5f5f5",
  "#6b3fa0",
  "#2a6e3f",
  "#1e90ff",
];

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)] as T;

const randomAppearance = () => ({
  color: pick(COLORS),
  octopus: {
    animation: pick(ANIMATIONS),
    expression: pick(EXPRESSIONS),
    accessory: pick(ACCESSORIES),
    hairColor: pick(HAIR_COLORS),
  },
});

const parseFlag = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
};

const parseJsonFlag = (flag: string): Record<string, string> | undefined => {
  const raw = parseFlag(flag);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`Error: ${flag} must be a JSON object.`);
      process.exit(1);
    }

    const entries = Object.entries(parsed).filter(([, value]) => typeof value === "string");
    return Object.fromEntries(entries);
  } catch {
    console.error(`Error: ${flag} must be valid JSON.`);
    process.exit(1);
  }
};

const parseObjectFlag = (flag: string): Record<string, unknown> => {
  const raw = parseFlag(flag);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`Error: ${flag} must be a JSON object.`);
      process.exit(1);
    }
    return parsed as Record<string, unknown>;
  } catch {
    console.error(`Error: ${flag} must be valid JSON.`);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// Back-office tools (#45 W-ORCH-NATIVE Phase 2). The fleet consumes the kept
// :3001 back-office services (CRM, Sara voice, ...) as TOOLS via this curated
// command — never the retired delegation engine. See fleet/BACKOFFICE-TOOLS.md.
// ---------------------------------------------------------------------------

const backOfficeList = () => {
  const tools = getBackOfficeToolDefinitions();
  console.log("Back-office tools (#45 Phase 2 — :3001 services consumed as TOOLS):");
  for (const tool of tools) {
    const flag = tool.mutates ? "  [write]" : "";
    console.log(`  ${tool.name}  (${tool.method} ${tool.pathTemplate})${flag}`);
    console.log(`      ${tool.description}`);
  }
};

const backOfficeDescribe = () => {
  const name = args[2];
  if (!name || name.startsWith("-")) {
    console.error("Error: tool name is required.");
    process.exit(1);
  }
  const tool = findBackOfficeTool(name);
  if (!tool) {
    console.error(`Error: unknown back-office tool "${name}". Run \`octogent backoffice list\`.`);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        name: tool.name,
        method: tool.method,
        path: tool.pathTemplate,
        mutates: tool.mutates,
        inputSchema: toBackOfficeInputSchema(tool),
      },
      null,
      2,
    ),
  );
};

const backOfficeCall = async () => {
  const name = args[2];
  if (!name || name.startsWith("-")) {
    console.error("Error: tool name is required.");
    process.exit(1);
  }
  const toolArgs = parseObjectFlag("--args");
  try {
    const config = resolveBackOfficeConfigFromEnv();
    const result = await executeBackOfficeTool(name, toolArgs, config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exit(1);
    }
  } catch (error) {
    const message =
      error instanceof BackOfficeConfigError || error instanceof BackOfficeToolError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// D4 adversarial-verify (#45 W-ORCH-NATIVE Phase 2 quality parity). Emits the
// refute-by-default audit prompt for a work product so an operator/agent can run
// it; the structured verdict schema is `octogent verify --schema`. Pure prompt
// builder lives in @octogent/core (verifyHarness). See fleet/VERIFY-HARNESS.md.
// ---------------------------------------------------------------------------

const runVerify = () => {
  if (args.includes("--schema")) {
    console.log(JSON.stringify(VERIFY_VERDICT_JSON_SCHEMA, null, 2));
    return;
  }

  const descriptorRaw = parseFlag("--descriptor");
  const base: Record<string, unknown> = descriptorRaw ? parseObjectFlag("--descriptor") : {};

  const title = parseFlag("--title") ?? (typeof base.title === "string" ? base.title : undefined);
  const claim = parseFlag("--claim") ?? (typeof base.claim === "string" ? base.claim : undefined);
  const scope = parseFlag("--scope") ?? (typeof base.scope === "string" ? base.scope : undefined);
  const context =
    parseFlag("--context") ?? (typeof base.context === "string" ? base.context : undefined);

  if (!title || !claim) {
    console.error(
      "Error: verify needs --title and --claim (or a --descriptor JSON with title + claim). Use `octogent verify --schema` to print the verdict schema.",
    );
    process.exit(1);
  }

  const descriptor: WorkProductDescriptor = { title, claim };
  if (scope) descriptor.scope = scope;
  if (context) descriptor.context = context;
  if (Array.isArray(base.evidence)) {
    descriptor.evidence = base.evidence as EvidenceItem[];
  }

  try {
    console.log(buildVerifyPrompt(descriptor));
  } catch (error) {
    const message =
      error instanceof VerifyHarnessError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// #45 W-ORCH-NATIVE Phase 3 [D9] — chat-parity contract. Inspects the parity
// matrix that gates retiring the legacy :3001 dashboard Chat (no hard cut until
// every non-drop capability is native or a proven adapter). Pure registry lives
// in @octogent/core (chatParity). See fleet/CHAT-PARITY.md.
// ---------------------------------------------------------------------------

const runChatParity = () => {
  const summary = summarizeChatParity();
  if (args.includes("--summary")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const symbol: Record<string, string> = {
    native: "[native] ",
    adapter: "[adapter]",
    drop: "[drop]   ",
  };
  console.log("Chat-parity matrix (#45 Phase 3 [D9] — supersede the dashboard Chat):");
  for (const cap of getChatParityCapabilities()) {
    const proven = cap.disposition === "adapter" ? (cap.parityProven ? " ✓" : " …") : "";
    console.log(
      `  ${symbol[cap.disposition] ?? cap.disposition} ${cap.id}${proven}  (legacy ${cap.legacyRoute})`,
    );
    console.log(`      ${cap.title} — ${cap.octogentParity}`);
  }
  console.log(`\n  ${summary.native} native · ${summary.adapter} adapter · ${summary.drop} drop`);
  console.log(
    `  retire-ready: ${summary.retireReady ? "YES" : "NO"}${summary.pendingAdapters.length ? ` (pending adapters: ${summary.pendingAdapters.join(", ")})` : ""}`,
  );
};

const tentacleCreate = async () => {
  const name = args[2];
  if (!name || name.startsWith("-")) {
    console.error("Error: tentacle name is required.");
    process.exit(1);
  }

  const description = parseFlag("--description") ?? parseFlag("-d") ?? "";
  const { color, octopus } = randomAppearance();
  const apiBase = resolveRuntimeApiBase();

  try {
    const response = await fetch(`${apiBase}/api/deck/tentacles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
      body: JSON.stringify({ name, description, color, octopus }),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(`Created tentacle "${data.tentacleId}"`);
  } catch {
    apiError();
  }
};

const tentacleList = async () => {
  const apiBase = resolveRuntimeApiBase();

  try {
    const response = await fetch(`${apiBase}/api/deck/tentacles`);
    if (!response.ok) {
      console.error("Error: failed to fetch tentacles.");
      process.exit(1);
    }

    const tentacles = (await response.json()) as Array<Record<string, unknown>>;
    if (tentacles.length === 0) {
      console.log("No tentacles found.");
      return;
    }

    for (const tentacle of tentacles) {
      const description = tentacle.description ? ` — ${tentacle.description}` : "";
      console.log(`  ${tentacle.tentacleId}${description}`);
    }
  } catch {
    apiError();
  }
};

const terminalCreate = async () => {
  const name = parseFlag("--name") ?? parseFlag("-n");
  const initialPrompt = parseFlag("--initial-prompt") ?? parseFlag("-p");
  const workspaceMode = parseFlag("--workspace-mode") ?? parseFlag("-w") ?? "shared";
  const terminalId = parseFlag("--terminal-id");
  const tentacleId = parseFlag("--tentacle-id");
  const worktreeId = parseFlag("--worktree-id");
  const parentTerminalId = parseFlag("--parent-terminal-id");
  const nameOrigin = parseFlag("--name-origin");
  const autoRenamePromptContext = parseFlag("--auto-rename-prompt-context");
  const promptTemplate = parseFlag("--prompt-template");
  const promptVariables = parseJsonFlag("--prompt-variables");
  const cwdScope = parseFlag("--cwd-scope");
  const apiBase = resolveRuntimeApiBase();

  const body: Record<string, unknown> = {};
  if (name) body.name = name;
  if (initialPrompt) body.initialPrompt = initialPrompt;
  if (workspaceMode) body.workspaceMode = workspaceMode;
  if (terminalId) body.terminalId = terminalId;
  if (tentacleId) body.tentacleId = tentacleId;
  if (worktreeId) body.worktreeId = worktreeId;
  if (parentTerminalId) body.parentTerminalId = parentTerminalId;
  if (nameOrigin) body.nameOrigin = nameOrigin;
  if (autoRenamePromptContext) body.autoRenamePromptContext = autoRenamePromptContext;
  if (promptTemplate) body.promptTemplate = promptTemplate;
  if (promptVariables) body.promptVariables = promptVariables;
  if (cwdScope === "vault") body.cwdScope = "vault";

  try {
    const response = await fetch(`${apiBase}/api/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(`Created terminal "${data.terminalId}"`);
  } catch {
    apiError();
  }
};

const channelSend = async () => {
  const terminalId = args[2];
  if (!terminalId || terminalId.startsWith("-")) {
    console.error("Error: target terminalId is required.");
    process.exit(1);
  }

  const fromTerminalId = parseFlag("--from") ?? process.env.OCTOGENT_SESSION_ID ?? "";
  const fromIndex = args.indexOf("--from");
  const message =
    fromIndex !== -1
      ? args
          .slice(3)
          .filter((_, index) => {
            const absoluteIndex = index + 3;
            return absoluteIndex !== fromIndex && absoluteIndex !== fromIndex + 1;
          })
          .join(" ")
          .trim()
      : args
          .slice(3)
          .filter((value) => !value.startsWith("--from"))
          .join(" ")
          .trim();

  if (!message) {
    console.error("Error: message content is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/channels/${encodeURIComponent(terminalId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuthHeaders() },
        body: JSON.stringify({ fromTerminalId, content: message }),
      },
    );
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(`Message sent (${data.messageId}) to ${terminalId}`);
  } catch {
    apiError();
  }
};

const channelList = async () => {
  const terminalId = args[2];
  if (!terminalId || terminalId.startsWith("-")) {
    console.error("Error: terminalId is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/channels/${encodeURIComponent(terminalId)}/messages`,
    );
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }

    const messages = (data.messages ?? []) as Array<Record<string, unknown>>;
    if (messages.length === 0) {
      console.log(`No messages for ${terminalId}.`);
      return;
    }

    for (const message of messages) {
      const status = message.delivered ? "delivered" : "pending";
      const fromDisplay =
        (typeof message.fromTerminalName === "string" && message.fromTerminalName) ||
        message.fromTerminalId ||
        "(unknown)";
      console.log(
        `  [${message.messageId}] from=${fromDisplay} status=${status}: ${message.content}`,
      );
    }
  } catch {
    apiError();
  }
};

const main = async () => {
  if (!command || command === "start") {
    return startServer();
  }

  if (command === "init") {
    return initProject(args[1]);
  }

  if (command === "projects" || command === "project") {
    const projects = loadProjectsRegistry().projects;
    if (projects.length === 0) {
      console.log(
        "No projects registered yet. Run `octogent` or `octogent init` in a project directory.",
      );
      return;
    }

    for (const project of projects) {
      console.log(`  ${project.name}  ${project.id}  ${project.path}`);
    }
    return;
  }

  if (command === "tentacle" || command === "tentacles") {
    if (args[1] === "create") {
      return tentacleCreate();
    }
    if (args[1] === "list" || args[1] === "ls") {
      return tentacleList();
    }
  }

  if (command === "terminal" || command === "terminals") {
    if (args[1] === "create") {
      return terminalCreate();
    }
  }

  if (command === "channel") {
    if (args[1] === "send") {
      return channelSend();
    }
    if (args[1] === "list" || args[1] === "ls") {
      return channelList();
    }
  }

  if (command === "backoffice") {
    if (args[1] === "list" || args[1] === "ls") {
      return backOfficeList();
    }
    if (args[1] === "describe") {
      return backOfficeDescribe();
    }
    if (args[1] === "call") {
      return backOfficeCall();
    }
  }

  if (command === "verify") {
    return runVerify();
  }

  if (command === "chat-parity") {
    return runChatParity();
  }

  console.log(`Usage:
  octogent                             Start the dashboard in the current project
  octogent init [project-name]         Initialize the current directory explicitly
  octogent projects                    List registered projects

  octogent tentacle create <name>      Create a tentacle (Octogent must be running)
  octogent tentacle list               List tentacles
  octogent terminal create [options]   Create a terminal
    --name, -n                         Terminal display name
    --workspace-mode, -w               shared | worktree
    --initial-prompt, -p               Raw initial prompt text
    --terminal-id                      Explicit terminal ID
    --tentacle-id                      Existing tentacle ID to attach to
    --worktree-id                      Explicit worktree ID
    --parent-terminal-id               Parent terminal ID for child terminals
    --prompt-template                  Prompt template name
    --prompt-variables                 JSON object of prompt template variables
  octogent channel send <id> <msg>     Send a channel message
  octogent channel list <id>           List channel messages

  octogent backoffice list             List the :3001 back-office tools (#45 Phase 2)
  octogent backoffice describe <tool>  Show a tool's HTTP mapping + input schema
  octogent backoffice call <tool>      Call a back-office tool
    --args '<json>'                    Tool arguments as a JSON object
                                       (needs COLLEGA_BACKOFFICE_BASE_URL + _API_KEY)

  octogent verify [options]            Emit the D4 refute-by-default audit prompt (#45 Phase 2)
    --title <text>                     Work-product title
    --claim <text>                     The claim to refute by default
    --scope <text>                     In-scope fence (flags scope creep)
    --context <text>                   Extra auditor context
    --descriptor '<json>'              Full WorkProductDescriptor JSON (incl. evidence[])
    --schema                           Print the verdict JSON schema instead of the prompt

  octogent chat-parity                 Show the dashboard-Chat supersede matrix (#45 Phase 3)
    --summary                          Print the parity summary + retire-ready gate as JSON`);
  process.exit(1);
};

main();
