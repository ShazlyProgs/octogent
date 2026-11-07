import { join } from "node:path";
import { readDeckTentacles, removeDeckStateEntry } from "../deck/readDeckTentacles";
import { isDeleteTombstoneEnabled, quarantineDeckTentacleFolder } from "../deck/tentacleTombstones"; // P41
import { resolvePrompt } from "../prompts";
import {
  RuntimeInputError,
  type TentacleWorkspaceMode,
  type TerminalAgentProvider,
  type TerminalNameOrigin,
} from "../terminalRuntime";
import type { ApiRouteHandler } from "./routeHelpers";
import {
  readJsonBodyOrWriteError,
  writeJson,
  writeMethodNotAllowed,
  writeNoContent,
} from "./routeHelpers";
import {
  parseTerminalAgentProvider,
  parseTerminalName,
  parseTerminalNameOrigin,
  parseTerminalWorkspaceMode,
} from "./terminalParsers";

const buildTentacleInitialPrompt = (
  promptsDir: string,
  workspaceCwd: string,
  projectStateDir: string,
  tentacleId: string,
): Promise<string | undefined> => {
  const tentacle = readDeckTentacles(workspaceCwd, projectStateDir).find(
    (entry) => entry.tentacleId === tentacleId,
  );
  if (!tentacle) {
    return Promise.resolve(undefined);
  }

  const tentacleFolderPath = join(".octogent", "tentacles", tentacleId);
  return resolvePrompt(promptsDir, "tentacle-context-init", {
    tentacleName: tentacle.displayName,
    tentacleId,
    tentacleContextPath: tentacleFolderPath,
  });
};

export const handleTerminalSnapshotsRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  // P38: GET /api/terminal-snapshots/:id (OCTO_API_SNAPSHOT_ITEM=1) so wakers get JSON, not the SPA page.
  const p38Item = /^\/api\/terminal-snapshots\/([^/]+)$/.exec(requestUrl.pathname);
  if (p38Item && process.env.OCTO_API_SNAPSHOT_ITEM === "1") {
    if (request.method !== "GET") { writeMethodNotAllowed(response, corsOrigin); return true; }
    const id = decodeURIComponent(p38Item[1] as string);
    const one = (runtime.listTerminalSnapshots() as Array<{ terminalId: string }>).find((s) => s.terminalId === id);
    if (!one) writeJson(response, 404, { error: `Unknown terminal ${id}` }, corsOrigin); else writeJson(response, 200, one, corsOrigin);
    return true;
  }
  if (requestUrl.pathname !== "/api/terminal-snapshots") {
    return false;
  }

  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const payload = runtime.listTerminalSnapshots();
  writeJson(response, 200, payload, corsOrigin);
  return true;
};

export const handleTerminalsCollectionRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir, promptsDir, userPromptsDir, getApiPort },
) => {
  if (requestUrl.pathname !== "/api/terminals") {
    return false;
  }

  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyReadResult.ok) {
    return true;
  }

  const nameResult = parseTerminalName(bodyReadResult.payload);
  if (nameResult.error) {
    writeJson(response, 400, { error: nameResult.error }, corsOrigin);
    return true;
  }

  const workspaceModeResult = parseTerminalWorkspaceMode(bodyReadResult.payload);
  if (workspaceModeResult.error) {
    writeJson(response, 400, { error: workspaceModeResult.error }, corsOrigin);
    return true;
  }

  const agentProviderResult = parseTerminalAgentProvider(bodyReadResult.payload);
  if (agentProviderResult.error) {
    writeJson(response, 400, { error: agentProviderResult.error }, corsOrigin);
    return true;
  }

  const nameOriginResult = parseTerminalNameOrigin(bodyReadResult.payload);
  if (nameOriginResult.error) {
    writeJson(response, 400, { error: nameOriginResult.error }, corsOrigin);
    return true;
  }

  try {
    const createTerminalInput: {
      terminalId?: string;
      tentacleId?: string;
      worktreeId?: string;
      tentacleName?: string;
      workspaceMode: TentacleWorkspaceMode;
      agentProvider?: TerminalAgentProvider;
      nameOrigin?: TerminalNameOrigin;
      initialPrompt?: string;
      initialInputDraft?: string;
      autoRenamePromptContext?: string;
      parentTerminalId?: string;
      metadata?: Record<string, string>;
      cwdScope?: "vault";
    } = {
      workspaceMode: workspaceModeResult.workspaceMode,
    };
    if (nameResult.name !== undefined) {
      createTerminalInput.tentacleName = nameResult.name;
    }
    if (agentProviderResult.agentProvider !== undefined) {
      createTerminalInput.agentProvider = agentProviderResult.agentProvider;
    }
    if (nameOriginResult.nameOrigin !== undefined) {
      createTerminalInput.nameOrigin = nameOriginResult.nameOrigin;
    }
    const bodyPayload = bodyReadResult.payload as Record<string, unknown> | null;
    if (
      bodyPayload &&
      typeof bodyPayload.terminalId === "string" &&
      bodyPayload.terminalId.trim().length > 0
    ) {
      createTerminalInput.terminalId = bodyPayload.terminalId.trim();
    }
    if (
      bodyPayload &&
      typeof bodyPayload.tentacleId === "string" &&
      bodyPayload.tentacleId.trim().length > 0
    ) {
      createTerminalInput.tentacleId = bodyPayload.tentacleId.trim();
    }
    if (
      bodyPayload &&
      typeof bodyPayload.parentTerminalId === "string" &&
      bodyPayload.parentTerminalId.trim().length > 0
    ) {
      createTerminalInput.parentTerminalId = bodyPayload.parentTerminalId.trim();
    }
    if (bodyPayload && bodyPayload.cwdScope === "vault") {
      createTerminalInput.cwdScope = "vault";
    }
    if (
      bodyPayload &&
      typeof bodyPayload.autoRenamePromptContext === "string" &&
      bodyPayload.autoRenamePromptContext.trim().length > 0
    ) {
      createTerminalInput.autoRenamePromptContext = bodyPayload.autoRenamePromptContext.trim();
    }
    if (
      bodyPayload &&
      typeof bodyPayload.worktreeId === "string" &&
      bodyPayload.worktreeId.trim().length > 0
    ) {
      createTerminalInput.worktreeId = bodyPayload.worktreeId.trim();
    }
    if (bodyPayload?.metadata && typeof bodyPayload.metadata === "object") {
      createTerminalInput.metadata = Object.fromEntries(
        Object.entries(bodyPayload.metadata as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([key, value]) => [key, value.trim()]),
      );
    }

    // Support prompt resolution via template name + variables, or a raw string.
    if (
      bodyPayload &&
      typeof bodyPayload.promptTemplate === "string" &&
      bodyPayload.promptTemplate.trim().length > 0
    ) {
      const templateName = bodyPayload.promptTemplate.trim();
      const templateVars: Record<string, string> =
        bodyPayload.promptVariables != null &&
        typeof bodyPayload.promptVariables === "object" &&
        !Array.isArray(bodyPayload.promptVariables)
          ? Object.fromEntries(
              Object.entries(bodyPayload.promptVariables as Record<string, unknown>)
                .filter(([, v]) => typeof v === "string")
                .map(([k, v]) => [k, v as string]),
            )
          : {};

      // Auto-inject terminalId variable so callers don't have to guess it.
      // Pre-allocate the real terminal id up-front so {{terminalId}} resolves
      // to (e.g.) "terminal-5" instead of the tentacle name — prompts that
      // call channel APIs or reference the id directly need the runtime id.
      if (!templateVars.terminalId) {
        if (!createTerminalInput.terminalId) {
          createTerminalInput.terminalId = runtime.allocateTerminalId();
        }
        templateVars.terminalId = createTerminalInput.terminalId;
      }

      // Auto-inject apiPort so prompt templates can reference the local API.
      if (!templateVars.apiPort) {
        templateVars.apiPort = getApiPort();
      }

      // Auto-inject userPromptsDir so prompt templates know where to save user prompts.
      if (!templateVars.userPromptsDir) {
        templateVars.userPromptsDir = userPromptsDir;
      }

      // Auto-inject existingTerminals summary so planner-style prompts have context.
      if (!templateVars.existingTerminals) {
        const deckTentacles = readDeckTentacles(workspaceCwd, projectStateDir);
        if (deckTentacles.length > 0) {
          const listing = deckTentacles
            .map(
              (t) =>
                `- **${t.displayName}** (\`${t.tentacleId}\`): ${t.description || "(no description)"}`,
            )
            .join("\n");
          templateVars.existingTerminals = `## Existing Terminals\n\nThe following departments already exist:\n\n${listing}\n\nConsider these when proposing new departments — avoid duplicates and note any gaps.`;
        } else {
          templateVars.existingTerminals =
            "## Existing Terminals\n\nNo department terminals exist yet. You are starting from scratch.";
        }
      }

      const resolved = await resolvePrompt(promptsDir, templateName, templateVars);
      if (resolved !== undefined) {
        createTerminalInput.initialPrompt = resolved;
      }
    } else if (
      bodyPayload &&
      typeof bodyPayload.initialPrompt === "string" &&
      bodyPayload.initialPrompt.trim().length > 0
    ) {
      createTerminalInput.initialPrompt = bodyPayload.initialPrompt.trim();
    }

    if (
      bodyPayload &&
      typeof bodyPayload.initialInputDraft === "string" &&
      bodyPayload.initialInputDraft.trim().length > 0
    ) {
      createTerminalInput.initialInputDraft = bodyPayload.initialInputDraft.trim();
    }

    if (
      !createTerminalInput.initialPrompt &&
      !createTerminalInput.initialInputDraft &&
      createTerminalInput.tentacleId
    ) {
      const defaultTentaclePrompt = await buildTentacleInitialPrompt(
        promptsDir,
        workspaceCwd,
        projectStateDir,
        createTerminalInput.tentacleId,
      );
      if (defaultTentaclePrompt) {
        createTerminalInput.initialInputDraft = defaultTentaclePrompt;
      }
    }

    const snapshot = runtime.createTerminal(createTerminalInput);
    const payload: Record<string, unknown> = { ...snapshot };
    if (createTerminalInput.initialPrompt) {
      payload.initialPrompt = createTerminalInput.initialPrompt;
    }
    writeJson(response, 201, payload, corsOrigin);
    return true;
  } catch (error) {
    if (error instanceof RuntimeInputError) {
      writeJson(response, 400, { error: error.message }, corsOrigin);
      return true;
    }

    throw error;
  }
};

const TERMINAL_ITEM_PATH_PATTERN = /^\/api\/terminals\/([^/]+)$/;
const TERMINAL_LIFECYCLE_PATH_PATTERN = /^\/api\/terminals\/([^/]+)\/(start|stop)$/;

export const handleTerminalLifecycleRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  const actionMatch = requestUrl.pathname.match(TERMINAL_LIFECYCLE_PATH_PATTERN);
  if (!actionMatch) {
    return false;
  }
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const terminalId = decodeURIComponent(actionMatch[1] ?? "");
  const action = actionMatch[2];
  let prompt: string | undefined;
  let agentProviderOverride: TerminalAgentProvider | undefined;
  if (action === "start") {
    const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
    if (!bodyReadResult.ok) {
      return true;
    }
    if (bodyReadResult.payload !== null) {
      const payload = bodyReadResult.payload as Record<string, unknown>;
      const promptValue = payload.prompt;
      if (
        typeof bodyReadResult.payload !== "object" ||
        Array.isArray(bodyReadResult.payload) ||
        !("prompt" in bodyReadResult.payload) ||
        typeof promptValue !== "string" ||
        !promptValue.trim()
      ) {
        writeJson(
          response,
          400,
          { error: 'Body must be {"prompt":"..."} when provided.' },
          corsOrigin,
        );
        return true;
      }
      prompt = promptValue.trim();
      const claudePayload = bodyReadResult.payload as Record<string, unknown> | null;
  if (claudePayload && typeof claudePayload === "object" && Object.hasOwn(claudePayload, "claudeSessionId")) {
    const value = claudePayload.claudeSessionId;
    if (value !== null && typeof value !== "string") {
      writeJson(response, 400, { error: "claudeSessionId must be a UUID string or null." }, corsOrigin);
      return true;
    }
    try {
      const payload = runtime.updateTerminalClaudeSessionId(terminalId, value === null ? null : value.trim());
      if (!payload) {
        writeJson(response, 404, { error: "Terminal not found." }, corsOrigin);
        return true;
      }
      writeJson(response, 200, payload, corsOrigin);
      return true;
    } catch (error) {
      if (error instanceof RuntimeInputError) {
        writeJson(response, 400, { error: error.message }, corsOrigin);
        return true;
      }
      throw error;
    }
  }

  const providerResult = parseTerminalAgentProvider(bodyReadResult.payload);
      if (providerResult.error) {
        writeJson(response, 400, { error: providerResult.error }, corsOrigin);
        return true;
      }
      agentProviderOverride = providerResult.agentProvider;
    }
  }

  try {
    const snapshot =
      action === "start"
        ? runtime.startTerminal(terminalId, prompt, agentProviderOverride)
        : runtime.stopTerminal(terminalId);
    if (!snapshot) {
      writeJson(response, 404, { error: "Terminal not found." }, corsOrigin);
      return true;
    }
    writeJson(response, 200, snapshot, corsOrigin);
    return true;
  } catch (error) {
    if (error instanceof RuntimeInputError) {
      writeJson(response, 409, { error: error.message }, corsOrigin);
      return true;
    }
    throw error;
  }
};


const TERMINAL_SESSION_PATH_PATTERN = /^\/api\/terminals\/([^/]+)\/session$/;

/** P42: store-only session id patch. Never respawns. Requires OCTO_FRESH_START_RESET_SESSION=1. */
export const handleTerminalSessionRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  const match = requestUrl.pathname.match(TERMINAL_SESSION_PATH_PATTERN);
  if (!match) return false;
  if (request.method !== "PATCH") { writeMethodNotAllowed(response, corsOrigin); return true; }
  const terminalId = decodeURIComponent(match[1] ?? "");
  const body = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!body.ok) return true;
  const value = body.payload as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    writeJson(response, 400, { error: "Body must be a JSON object." }, corsOrigin); return true;
  }
  const patch: { codexThreadId?: string | null; claudeSessionId?: string | null; clear?: boolean } = {};
  if (value.clear === true) patch.clear = true;
  if (Object.hasOwn(value, "codexThreadId")) {
    if (value.codexThreadId !== null && typeof value.codexThreadId !== "string") {
      writeJson(response, 400, { error: "codexThreadId must be a UUID string or null." }, corsOrigin); return true;
    }
    patch.codexThreadId = value.codexThreadId === null ? null : String(value.codexThreadId).trim();
  }
  if (Object.hasOwn(value, "claudeSessionId")) {
    if (value.claudeSessionId !== null && typeof value.claudeSessionId !== "string") {
      writeJson(response, 400, { error: "claudeSessionId must be a UUID string or null." }, corsOrigin); return true;
    }
    patch.claudeSessionId = value.claudeSessionId === null ? null : String(value.claudeSessionId).trim();
  }
  if (!patch.clear && patch.codexThreadId === undefined && patch.claudeSessionId === undefined) {
    writeJson(response, 400, { error: "Provide clear:true and/or codexThreadId/claudeSessionId." }, corsOrigin); return true;
  }
  try {
    const payload = (runtime as { updateTerminalSessionIds?: Function }).updateTerminalSessionIds?.(terminalId, patch);
    if (!payload) { writeJson(response, 404, { error: "Terminal not found." }, corsOrigin); return true; }
    writeJson(response, 200, payload, corsOrigin);
  } catch (error) {
    if (error instanceof RuntimeInputError) { writeJson(response, 400, { error: error.message }, corsOrigin); return true; }
    throw error;
  }
  return true;
};

export const handleTerminalItemRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime, workspaceCwd, projectStateDir },
) => {
  const renameMatch = requestUrl.pathname.match(TERMINAL_ITEM_PATH_PATTERN);
  if (!renameMatch) {
    return false;
  }

  if (request.method !== "PATCH" && request.method !== "DELETE") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const terminalId = decodeURIComponent(renameMatch[1] ?? "");
  if (request.method === "DELETE") {
    try {
      // P30: keepWorktree=true removes only the record and runtime; never git worktree/branch deletes.
      const keepWorktree = requestUrl.searchParams.get("keepWorktree") === "true";
      const p41Before = isDeleteTombstoneEnabled() ? runtime.listTerminalSnapshots() : [];
      runtime.deleteTerminal(terminalId, { keepWorktree });
      if (p41Before.length > 0) {
        // P41: any tentacle left with zero terminals is removed from the deck too, so it never shows as a root ghost.
        const after = new Set(runtime.listTerminalSnapshots().map((t) => t.tentacleId));
        const gone = new Set(p41Before.map((t) => t.tentacleId).filter((id) => !after.has(id)));
        for (const tentacleId of gone) {
          try { quarantineDeckTentacleFolder(workspaceCwd, projectStateDir, tentacleId, `terminal-delete:${terminalId}`); removeDeckStateEntry(projectStateDir, tentacleId); }
          catch (error) { console.error("P41 tombstone failed:", error); }
        }
      }
      writeNoContent(response, 204, corsOrigin);
      return true;
    } catch (error) {
      if (error instanceof RuntimeInputError) {
        writeJson(response, 409, { error: error.message }, corsOrigin);
        return true;
      }
      throw error;
    }
  }

  const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyReadResult.ok) {
    return true;
  }

  const nameResult = parseTerminalName(bodyReadResult.payload);
  if (nameResult.error) {
    writeJson(response, 400, { error: nameResult.error }, corsOrigin);
    return true;
  }

  if (!nameResult.provided || !nameResult.name) {
    writeJson(response, 400, { error: "Terminal name is required." }, corsOrigin);
    return true;
  }

  const payload = runtime.renameTerminal(terminalId, nameResult.name);
  if (!payload) {
    writeJson(response, 404, { error: "Terminal not found." }, corsOrigin);
    return true;
  }

  writeJson(response, 200, payload, corsOrigin);
  return true;
};
