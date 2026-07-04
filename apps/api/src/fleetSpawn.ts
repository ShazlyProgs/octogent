/**
 * Fleet spawn runner (#45 W-ORCH-NATIVE Phase 1).
 *
 * Stages the C-suite tentacle seeds from <octogent>/fleet/tentacles/ into the project
 * state dir, registers each tentacle, and spawns the standing terminals in
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
 * --verify runs the D4 adversarial-verify auto-run over the completed spawn and appends
 * the audit artifact to <stateDir>/fleet-verify.log.jsonl (gate blocks the spawn on
 * REJECT). Without a wired verdict producer the audit prompt is recorded PENDING for an
 * operator/agent to run — it is never fabricated. Only takes effect with --execute.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  type FleetManifest,
  type VerdictProducer,
  type VerifyGateDecision,
  type VerifyVerdict,
  type WorkProductDescriptor,
  buildFleetSpawnPlan,
  parseFleetManifest,
  runAutoVerify,
} from "@octogent/core";

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
  manifest.roles.map((role) => {
    const targetDir = join(options.stateDir, "tentacles", role.id);
    return {
      roleId: role.id,
      sourceDir: join(options.packageRoot, "fleet", "tentacles", role.id),
      targetDir,
      shouldCopy: !options.targetExists(targetDir),
    };
  });

export const buildTentacleRegistrations = (manifest: FleetManifest): FleetTentacleRegistration[] =>
  manifest.roles.map((role) => ({
    roleId: role.id,
    requestBody: { name: role.id, description: role.description ?? "" },
  }));

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
// milestone the VERIFY-HARNESS.md cut-line deferred. Separable from the LATER A5
// autonomous loop ([D7]): the verdict PRODUCER is injected (default: none ⇒ the
// audit prompt is recorded PENDING for an operator/agent to run — it never
// fabricates a verdict). See fleet/VERIFY-HARNESS.md.
// ---------------------------------------------------------------------------

export type FleetVerifyArtifact = {
  fleetId: string;
  spawnedRoleIds: string[];
  status: "passed" | "blocked" | "pending";
  /** The emitted refute-by-default audit prompt (always present). */
  prompt: string;
  /** Parsed verdict, or null when no producer was supplied (status "pending"). */
  verdict: VerifyVerdict | null;
  decision: VerifyGateDecision | null;
  at: string;
};

export type FleetVerifyConfig = {
  enabled: boolean;
  /** Injected LLM/agent that runs the emitted audit prompt. Omit ⇒ PENDING record. */
  produceVerdict?: VerdictProducer;
  /** Sink for the audit artifact (append to a log, POST to a bus, etc.). */
  record: (artifact: FleetVerifyArtifact) => void;
  /** Block the spawn on APPROVE_WITH_FIXES too (default false). */
  blockOnFixes?: boolean;
};

export class FleetVerifyBlockedError extends Error {
  readonly artifact: FleetVerifyArtifact;
  constructor(artifact: FleetVerifyArtifact) {
    super(`Fleet spawn blocked by adversarial-verify: ${artifact.decision?.reason ?? "REJECT"}`);
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
    claim: `The fleet spawn stood up ${roleIds.length} standing C-suite tentacle(s) parent-before-child, each registered on the deck and given a live terminal id, with no orphaned child.`,
    scope:
      "fleet spawn only — the standing C-suite tentacles declared in fleet.json; NOT specialist worktrees and NO back-office mutation.",
    evidence: roleIds.map((roleId) => ({
      kind: "terminal",
      reference: `${roleId} -> ${spawned.get(roleId) ?? "(missing)"}`,
      detail: "spawned terminal id",
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
  const result = await runAutoVerify(descriptor, {
    ...(config.produceVerdict ? { produceVerdict: config.produceVerdict } : {}),
    gate: { blockOnFixes: config.blockOnFixes ?? false },
  });
  const artifact: FleetVerifyArtifact = {
    fleetId: manifest.fleetId,
    spawnedRoleIds: [...spawned.keys()],
    status: result.status,
    prompt: result.prompt,
    verdict: result.verdict,
    decision: result.decision,
    at: new Date().toISOString(),
  };
  config.record(artifact);
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
    const body = {
      ...request.requestBody,
      promptVariables: { ...request.requestBody.promptVariables },
    };
    if (request.parentRoleId !== null) {
      const parentTerminalId = terminalIdsByRole.get(request.parentRoleId);
      if (execute && !parentTerminalId) {
        throw new Error(
          `Cannot spawn "${request.roleId}": parent "${request.parentRoleId}" has no terminal id`,
        );
      }
      body.parentTerminalId = parentTerminalId ?? `<terminal of ${request.parentRoleId}>`;
      body.promptVariables.parentTerminalId = body.parentTerminalId;
    } else if (options.bossTerminalId) {
      body.parentTerminalId = options.bossTerminalId;
    }
    log(
      `spawn  ${request.roleId}: POST /api/terminals (parent=${body.parentTerminalId ?? "none"})`,
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
    log(`spawn  ${request.roleId}: terminal "${terminalId}" created`);
  }

  // 4. D4 auto-verify hook (config-gated) — audit the spawn as a work product and
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
  const verifyEnabled = process.env.OCTOGENT_FLEET_VERIFY === "1" || argv.includes("--verify");
  runFleetSpawn({
    packageRoot,
    stateDir,
    apiBase: parseCliFlag(argv, "--api-base") ?? "http://127.0.0.1:8787",
    bossTerminalId: parseCliFlag(argv, "--boss-terminal-id"),
    execute: argv.includes("--execute"),
    log: (line) => console.log(line),
    ...(verifyEnabled
      ? {
          verify: {
            enabled: true,
            blockOnFixes: process.env.OCTOGENT_FLEET_VERIFY_BLOCK_ON_FIXES === "1",
            record: (artifact: FleetVerifyArtifact) =>
              appendFleetVerifyArtifact(stateDir, artifact),
          },
        }
      : {}),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
