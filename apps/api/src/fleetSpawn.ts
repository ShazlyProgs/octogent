/**
 * Fleet spawn runner (#45 W-ORCH-NATIVE Phase 1).
 *
 * Stages the C-suite tentacle seeds from <octogent>/fleet/tentacles/ into the project
 * state dir, starts the CEO, and registers dormant standing roles and profiles in
 * parent-before-child order against a RUNNING octogent daemon.
 *
 * DRY-RUN BY DEFAULT — pass --execute to act. Standing the fleet up is an
 * operator-gated action (it perturbs the live dashboard fleet); see fleet/README.md.
 *
 * Usage (from the octogent repo root, daemon running):
 *   pnpm fleet:spawn -- [--execute] [--boss-terminal-id <id>]
 *                       [--api-base http://127.0.0.1:8787] [--state-dir <path>]
 *                       [--verify]   (or env OCTOGENT_FLEET_VERIFY=1)
 *
 * --verify runs the D4 adversarial-verify auto-run over the completed spawn, persists the
 * verdict + full-trace pointer to <stateDir>/fleet-verify.log.jsonl, and surfaces it to the
 * fleet root. REJECT and verifier failures block. Only takes effect with --execute.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  type FleetManifest,
  type TerminalAgentProvider,
  type VerifyGateDecision,
  type VerifyVerdict,
  type WorkProductDescriptor,
  buildFleetSpawnPlan,
  buildProfileRecords,
  buildVerifyPrompt,
  parseFleetManifest,
  runAutoVerify,
} from "@octogent/core";
import { createFleetVerdictProducer, surfaceFleetVerifyArtifact } from "./fleetVerifyRuntime";
import { resolvePrompt } from "./prompts";

export type FleetStageAction = {
  roleId: string;
  sourceDir: string;
  targetDir: string;
  /** false when the target already exists — the runner leaves it untouched. */
  shouldCopy: boolean;
};

export type FleetTentacleRegistration = {
  roleId: string;
  requestBody: { name: string; description: string };
};

export type FleetTerminalRequest = {
  roleId: string;
  requestBody: {
    name: string;
    workspaceMode: string;
    tentacleId: string;
    promptTemplate: string;
    promptVariables: Record<string, string>;
    parentTerminalId?: string;
    agentProvider?: TerminalAgentProvider;
  };
};

export const loadFleetManifest = (packageRoot: string): FleetManifest => {
  const manifestPath = join(packageRoot, "fleet", "fleet.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  return parseFleetManifest(raw);
};

/** Default state dir per REPOS.md: $STATE = <workspace root>/.octogent, where the
 * octogent repo lives at <workspace root>/Agents/octogent. Override with --state-dir. */
export const resolveDefaultStateDir = (packageRoot: string): string =>
  resolve(packageRoot, "..", "..", ".octogent");

export const buildStageActions = (
  manifest: FleetManifest,
  options: { packageRoot: string; stateDir: string; targetExists: (path: string) => boolean },
): FleetStageAction[] =>
  [
    ...manifest.roles.map((role) => ({
      id: role.id,
      seedDir: join("fleet", "tentacles", role.id),
    })),
    ...manifest.profiles
      .filter((profile) => profile.kind === "profile")
      .map((profile) => ({ id: profile.id, seedDir: profile.seedDir })),
  ].map((identity) => {
    const targetDir = join(options.stateDir, "tentacles", identity.id);
    return {
      roleId: identity.id,
      sourceDir: join(options.packageRoot, identity.seedDir),
      targetDir,
      shouldCopy: !options.targetExists(targetDir),
    };
  });

export const buildTentacleRegistrations = (
  manifest: FleetManifest,
): FleetTentacleRegistration[] => [
  ...manifest.roles.map((role) => ({
    roleId: role.id,
    requestBody: { name: role.id, description: role.description ?? "" },
  })),
  ...manifest.profiles.map((profile) => ({
    roleId: profile.id,
    requestBody: {
      name: profile.id,
      description:
        profile.kind === "bound-service"
          ? `${profile.name}: bound-service representation; never a Claude session.`
          : `${profile.name}: dormant summon-on-demand profile.`,
    },
  })),
];

/**
 * Build the POST /api/terminals bodies in spawn-plan order. The parent terminal id of
 * a child is not known until the parent spawn responds, so bodies reference parents via
 * the placeholder returned in `parentRoleId`; the executor resolves it at spawn time.
 */
export const buildTerminalRequests = (
  manifest: FleetManifest,
  options: { stateDir: string; bossTerminalId?: string | undefined },
): Array<FleetTerminalRequest & { parentRoleId: string | null }> => {
  const plan = buildFleetSpawnPlan(manifest);
  return plan.map((step) => {
    const promptVariables: Record<string, string> = {
      roleName: step.name,
      roleId: step.roleId,
      fleetId: manifest.fleetId,
      tentacleContextPath: join(options.stateDir, "tentacles", step.roleId),
      // {{parentTerminalId}} in the prompt template; the root gets the boss terminal
      // (or empty = answers to Mohamed directly), children get the parent's live id.
      parentTerminalId: step.parentRoleId === null ? (options.bossTerminalId ?? "") : "",
    };
    return {
      roleId: step.roleId,
      parentRoleId: step.parentRoleId,
      requestBody: {
        name: step.name,
        workspaceMode: step.workspaceMode,
        tentacleId: step.roleId,
        promptTemplate: step.promptTemplate,
        promptVariables,
        ...(step.agentProvider ? { agentProvider: step.agentProvider } : {}),
      },
    };
  });
};

// ---------------------------------------------------------------------------
// D4 auto-verify hook (#45 W-ORCH-NATIVE Phase 2 [D4] quality parity).
//
// The fleet spawn is itself a work product ("stood up N standing tentacles
// parent-before-child, no orphaned child"). This config-gated hook audits that
// claim with the adversarial-verify harness (@octogent/core runAutoVerify),
// records the artifact, and GATES on REJECT — the "auto-run in the spawn loop"
// milestone the VERIFY-HARNESS.md cut-line deferred. Separable from the gated A5
// autonomous proposer ([D7]): the production producer is an injected Octogent-native
// verifier adapter and the deterministic gate never fabricates a verdict.
// ---------------------------------------------------------------------------

export type FleetVerifyArtifact = {
  fleetId: string;
  spawnedRoleIds: string[];
  status: "passed" | "blocked" | "pending";
  /** Stable operator-facing pass/fail result; pending only exists for injected/manual adapters. */
  outcome: "pass" | "fail" | "pending";
  /** The emitted refute-by-default audit prompt (always present). */
  prompt: string;
  /** Parsed verdict, or null when no producer was supplied (status "pending"). */
  verdict: VerifyVerdict | null;
  decision: VerifyGateDecision | null;
  /** Full append-only terminal transcript, never a summary. */
  tracePointer: string | null;
  verifierTerminalId: string | null;
  /** Producer/validation failure. A failed verifier blocks rather than failing open. */
  error: string | null;
  at: string;
};

export type FleetVerifyContext = {
  fleetId: string;
  parentTerminalId: string;
};

export type FleetVerdictProduction = {
  rawVerdict: unknown;
  tracePointer: string;
  verifierTerminalId: string;
};

export type FleetVerdictProducer = (
  prompt: string,
  context: FleetVerifyContext,
) => unknown | Promise<unknown>;

export type FleetVerifyConfig = {
  enabled: boolean;
  /** Injected LLM/agent that runs the emitted audit prompt. Omit ⇒ PENDING record. */
  produceVerdict?: FleetVerdictProducer;
  /** Sink for the audit artifact (append to a log, POST to a bus, etc.). */
  record: (artifact: FleetVerifyArtifact) => void | Promise<void>;
  /** Notify the owning officer/root after the verdict record is durable. */
  surface?: (artifact: FleetVerifyArtifact, context: FleetVerifyContext) => void | Promise<void>;
  /** Block the spawn on APPROVE_WITH_FIXES too (default false). */
  blockOnFixes?: boolean;
};

export class FleetVerifyBlockedError extends Error {
  readonly artifact: FleetVerifyArtifact;
  constructor(artifact: FleetVerifyArtifact) {
    super(
      `Fleet spawn blocked by adversarial-verify: ${artifact.decision?.reason ?? artifact.error ?? "REJECT"}`,
    );
    this.name = "FleetVerifyBlockedError";
    this.artifact = artifact;
  }
}

/** Describe the completed spawn as a work product for the adversarial verifier. */
export const buildFleetSpawnVerifyDescriptor = (
  manifest: FleetManifest,
  spawned: Map<string, string>,
): WorkProductDescriptor => {
  const roleIds = [...spawned.keys()];
  const expectedRoots = manifest.roles
    .filter((role) => role.parentRoleId === null)
    .map((role) => role.id);
  return {
    title: `fleet "${manifest.fleetId}" standing spawn`,
    claim: `The fleet runner created ${roleIds.length} standing C-suite terminal identities parent-before-child, with the root live and officers registered dormant, each on the deck with no orphaned child.`,
    scope:
      "fleet spawn only — the standing C-suite tentacles declared in fleet.json; NOT specialist worktrees and NO back-office mutation.",
    evidence: roleIds.map((roleId) => ({
      kind: "terminal",
      reference: `${roleId} -> ${spawned.get(roleId) ?? "(missing)"}`,
      detail: "registered terminal id",
    })),
    context: `#45 W-ORCH-NATIVE Phase 2 [D4] auto-verify hook. fleet.json declares ${manifest.roles.length} role(s); expected root(s): ${expectedRoots.join(", ") || "(none)"}.`,
  };
};

/**
 * Run the adversarial-verify auto-run over a completed spawn, record the artifact, and
 * throw FleetVerifyBlockedError when the gate blocks (REJECT, or APPROVE_WITH_FIXES with
 * blockOnFixes). With no producer the artifact is recorded PENDING and never blocks.
 */
export const runFleetSpawnVerify = async (
  manifest: FleetManifest,
  spawned: Map<string, string>,
  config: FleetVerifyConfig,
): Promise<FleetVerifyArtifact> => {
  const descriptor = buildFleetSpawnVerifyDescriptor(manifest, spawned);
  const rootRole = manifest.roles.find((role) => role.parentRoleId === null);
  const parentTerminalId = rootRole ? spawned.get(rootRole.id) : undefined;
  if (!parentTerminalId) {
    throw new Error("Fleet verify requires a spawned root terminal");
  }
  const context: FleetVerifyContext = { fleetId: manifest.fleetId, parentTerminalId };
  let tracePointer: string | null = null;
  let verifierTerminalId: string | null = null;
  const isProduction = (value: unknown): value is FleetVerdictProduction =>
    value !== null &&
    typeof value === "object" &&
    "rawVerdict" in value &&
    typeof (value as Partial<FleetVerdictProduction>).tracePointer === "string" &&
    typeof (value as Partial<FleetVerdictProduction>).verifierTerminalId === "string";
  const recordAndSurface = async (artifact: FleetVerifyArtifact): Promise<void> => {
    await config.record(artifact);
    await config.surface?.(artifact, context);
  };

  let result: Awaited<ReturnType<typeof runAutoVerify>>;
  try {
    result = await runAutoVerify(descriptor, {
      ...(config.produceVerdict
        ? {
            produceVerdict: async (prompt: string) => {
              const produced = await config.produceVerdict?.(prompt, context);
              if (isProduction(produced)) {
                tracePointer = produced.tracePointer;
                verifierTerminalId = produced.verifierTerminalId;
                return produced.rawVerdict;
              }
              return produced;
            },
          }
        : {}),
      gate: { blockOnFixes: config.blockOnFixes ?? false },
    });
  } catch (error) {
    const failure = error as {
      message?: unknown;
      tracePointer?: unknown;
      verifierTerminalId?: unknown;
    };
    const artifact: FleetVerifyArtifact = {
      fleetId: manifest.fleetId,
      spawnedRoleIds: [...spawned.keys()],
      status: "blocked",
      outcome: "fail",
      prompt: buildVerifyPrompt(descriptor),
      verdict: null,
      decision: null,
      tracePointer:
        tracePointer ?? (typeof failure.tracePointer === "string" ? failure.tracePointer : null),
      verifierTerminalId:
        verifierTerminalId ??
        (typeof failure.verifierTerminalId === "string" ? failure.verifierTerminalId : null),
      error: typeof failure.message === "string" ? failure.message : String(error),
      at: new Date().toISOString(),
    };
    await recordAndSurface(artifact);
    throw new FleetVerifyBlockedError(artifact);
  }
  const artifact: FleetVerifyArtifact = {
    fleetId: manifest.fleetId,
    spawnedRoleIds: [...spawned.keys()],
    status: result.status,
    outcome: result.status === "passed" ? "pass" : result.status === "blocked" ? "fail" : "pending",
    prompt: result.prompt,
    verdict: result.verdict,
    decision: result.decision,
    tracePointer,
    verifierTerminalId,
    error: null,
    at: new Date().toISOString(),
  };
  await recordAndSurface(artifact);
  if (result.status === "blocked") {
    throw new FleetVerifyBlockedError(artifact);
  }
  return artifact;
};

/** Default record sink for the CLI path — append one JSON line per audit to the state dir. */
export const appendFleetVerifyArtifact = (
  stateDir: string,
  artifact: FleetVerifyArtifact,
): void => {
  const logPath = join(stateDir, "fleet-verify.log.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(artifact)}\n`, "utf8");
};

type ExecuteOptions = {
  packageRoot: string;
  stateDir: string;
  apiBase: string;
  bossTerminalId?: string | undefined;
  execute: boolean;
  log: (line: string) => void;
  /** D4 auto-verify hook — audits the spawn + gates on REJECT. Omit ⇒ no verify. */
  verify?: FleetVerifyConfig | undefined;
};

const postJson = async (
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload };
};

export const runFleetSpawn = async (options: ExecuteOptions): Promise<void> => {
  const { packageRoot, stateDir, apiBase, execute, log } = options;
  const manifest = loadFleetManifest(packageRoot);
  const mode = execute ? "EXECUTE" : "DRY-RUN (pass --execute to act)";
  log(`Fleet "${manifest.fleetId}" — ${manifest.roles.length} standing roles — ${mode}`);
  log(`State dir: ${stateDir}`);

  // 1. Stage tentacle seed folders.
  const stageActions = buildStageActions(manifest, {
    packageRoot,
    stateDir,
    targetExists: existsSync,
  });
  for (const action of stageActions) {
    if (!existsSync(action.sourceDir)) {
      throw new Error(`Missing seed folder for role "${action.roleId}": ${action.sourceDir}`);
    }
    if (!action.shouldCopy) {
      log(`stage  ${action.roleId}: target exists, left untouched (${action.targetDir})`);
      continue;
    }
    log(`stage  ${action.roleId}: ${action.sourceDir} -> ${action.targetDir}`);
    if (execute) {
      cpSync(action.sourceDir, action.targetDir, { recursive: true, errorOnExist: false });
    }
  }

  // 2. Register tentacles (idempotent-ish: an "already exists" 400 is reported and skipped).
  for (const registration of buildTentacleRegistrations(manifest)) {
    log(`deck   ${registration.roleId}: POST /api/deck/tentacles`);
    if (!execute) continue;
    const result = await postJson(`${apiBase}/api/deck/tentacles`, registration.requestBody);
    if (!result.ok) {
      const message = String(result.payload.error ?? `HTTP ${result.status}`);
      if (/exist/i.test(message)) {
        log(`deck   ${registration.roleId}: already registered (${message})`);
      } else {
        throw new Error(`Failed to register tentacle "${registration.roleId}": ${message}`);
      }
    }
  }

  // 3. Spawn terminals parent-before-child, resolving parent terminal ids as we go.
  const terminalIdsByRole = new Map<string, string>();
  for (const request of buildTerminalRequests(manifest, {
    stateDir,
    bossTerminalId: options.bossTerminalId,
  })) {
    let body: Record<string, unknown> = {
      ...request.requestBody,
      promptVariables: { ...request.requestBody.promptVariables },
    };
    const promptVariables = body.promptVariables as Record<string, string>;
    if (request.parentRoleId !== null) {
      const parentTerminalId = terminalIdsByRole.get(request.parentRoleId);
      if (execute && !parentTerminalId) {
        throw new Error(
          `Cannot spawn "${request.roleId}": parent "${request.parentRoleId}" has no terminal id`,
        );
      }
      body.parentTerminalId = parentTerminalId ?? `<terminal of ${request.parentRoleId}>`;
      promptVariables.parentTerminalId = String(body.parentTerminalId);
    } else if (options.bossTerminalId) {
      body.parentTerminalId = options.bossTerminalId;
    }

    let action = "spawn";
    if (request.parentRoleId !== null) {
      const initialInputDraft = await resolvePrompt(
        join(packageRoot, "prompts"),
        request.requestBody.promptTemplate,
        promptVariables,
      );
      if (!initialInputDraft) {
        throw new Error(
          `Unable to resolve dormant role charter "${request.requestBody.promptTemplate}" for "${request.roleId}"`,
        );
      }
      body = {
        name: request.requestBody.name,
        workspaceMode: request.requestBody.workspaceMode,
        tentacleId: request.requestBody.tentacleId,
        parentTerminalId: body.parentTerminalId,
        initialInputDraft,
        ...(request.requestBody.agentProvider
          ? { agentProvider: request.requestBody.agentProvider }
          : {}),
        metadata: {
          fleetId: manifest.fleetId,
          fleetRoleId: request.roleId,
          fleetRoleState: "standing-dormant",
        },
      };
      action = "record";
    }
    log(
      `${action.padEnd(6)} ${request.roleId}: POST /api/terminals (parent=${String(body.parentTerminalId ?? "none")})`,
    );
    if (!execute) continue;
    const result = await postJson(`${apiBase}/api/terminals`, body);
    if (!result.ok) {
      throw new Error(
        `Failed to spawn "${request.roleId}": ${String(result.payload.error ?? result.status)}`,
      );
    }
    const terminalId = String(result.payload.terminalId ?? "");
    terminalIdsByRole.set(request.roleId, terminalId);
    log(`${action.padEnd(6)} ${request.roleId}: terminal "${terminalId}" created`);
  }

  // 4. Create parent-linked profile records without initialPrompt. These records are
  // visible but dormant; bound-service metadata also prevents later wake.
  const parentTerminalIds = Object.fromEntries(
    manifest.roles.map((role) => [
      role.id,
      terminalIdsByRole.get(role.id) ?? `<terminal of ${role.id}>`,
    ]),
  );
  const resolvedCharters: Record<string, string> = {};
  for (const profile of manifest.profiles) {
    const charter = await resolvePrompt(join(packageRoot, "prompts"), profile.promptTemplate, {
      roleName: profile.name,
      roleId: profile.id,
      fleetId: manifest.fleetId,
      parentTerminalId: parentTerminalIds[profile.parentRoleId] ?? "",
      tentacleContextPath: join(stateDir, "tentacles", profile.id),
    });
    if (!charter) {
      throw new Error(
        `Unable to resolve profile charter "${profile.promptTemplate}" for "${profile.id}"`,
      );
    }
    resolvedCharters[profile.id] = charter;
  }

  for (const profileRecord of buildProfileRecords(manifest, {
    parentTerminalIds,
    resolvedCharters,
  })) {
    log(
      `record ${profileRecord.profileId}: POST /api/terminals (parent=${profileRecord.requestBody.parentTerminalId}, kind=${profileRecord.kind})`,
    );
    if (!execute) continue;
    const result = await postJson(`${apiBase}/api/terminals`, profileRecord.requestBody);
    if (!result.ok) {
      throw new Error(
        `Failed to register profile "${profileRecord.profileId}": ${String(result.payload.error ?? result.status)}`,
      );
    }
    log(
      `record ${profileRecord.profileId}: dormant terminal "${String(result.payload.terminalId ?? "")}" created`,
    );
  }

  // 5. D4 auto-verify hook (config-gated) — audit the role spawn as a work product and
  //    gate on REJECT. Records the artifact; throws FleetVerifyBlockedError on block.
  if (execute && options.verify?.enabled) {
    log(`verify ${manifest.fleetId}: adversarial-verify of the fleet spawn`);
    const artifact = await runFleetSpawnVerify(manifest, terminalIdsByRole, options.verify);
    log(
      `verify ${manifest.fleetId}: ${artifact.status}${
        artifact.decision
          ? ` — ${artifact.decision.reason}`
          : " (no verdict producer — recorded PENDING for manual/agent audit)"
      }`,
    );
  }

  log(execute ? "Fleet spawn complete." : "Dry-run complete. Nothing was changed.");
};

const parseCliFlag = (argv: string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
};

const isDirectInvocation = () => {
  const entry = process.argv[1];
  return typeof entry === "string" && /fleetSpawn\.(ts|js)$/.test(entry.replaceAll("\\", "/"));
};

if (isDirectInvocation()) {
  const argv = process.argv.slice(2);
  const packageRoot = resolve(import.meta.dirname ?? ".", "..", "..", "..");
  const stateDir = parseCliFlag(argv, "--state-dir") ?? resolveDefaultStateDir(packageRoot);
  const apiBase = parseCliFlag(argv, "--api-base") ?? "http://127.0.0.1:8787";
  const verifyEnabled = process.env.OCTOGENT_FLEET_VERIFY === "1" || argv.includes("--verify");
  const configuredTimeout = Number(process.env.OCTOGENT_FLEET_VERIFY_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10 * 60_000;
  runFleetSpawn({
    packageRoot,
    stateDir,
    apiBase,
    bossTerminalId: parseCliFlag(argv, "--boss-terminal-id"),
    execute: argv.includes("--execute"),
    log: (line) => console.log(line),
    ...(verifyEnabled
      ? {
          verify: {
            enabled: true,
            blockOnFixes: process.env.OCTOGENT_FLEET_VERIFY_BLOCK_ON_FIXES === "1",
            produceVerdict: createFleetVerdictProducer({ apiBase, stateDir, timeoutMs }),
            record: (artifact: FleetVerifyArtifact) =>
              appendFleetVerifyArtifact(stateDir, artifact),
            surface: (artifact: FleetVerifyArtifact, context: FleetVerifyContext) =>
              surfaceFleetVerifyArtifact({
                apiBase,
                parentTerminalId: context.parentTerminalId,
                artifact,
              }),
          },
        }
      : {}),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
