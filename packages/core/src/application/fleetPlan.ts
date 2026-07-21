/**
 * Fleet plan — pure domain logic for the standing C-suite fleet (#45 W-ORCH-NATIVE Phase 1).
 *
 * A fleet manifest declares an org-chart tree of standing, dormant-by-default roles,
 * summon-on-demand profiles, and a policy block for ephemeral specialist worktree
 * subagents. This module validates the manifest and derives deterministic terminal
 * create requests. It performs no I/O — staging, prompt resolution, and API calls live
 * in the api app (ports-and-adapters boundary).
 */

import { type TerminalAgentProvider, isTerminalAgentProvider } from "../domain/agentRuntime";

export const DEFAULT_FLEET_MAX_CHILDREN_PER_PARENT = 9;

export type FleetWorkspaceMode = "shared" | "worktree";

export type FleetRoleDefinition = {
  /** Tentacle id (kebab-case). Doubles as the seed folder name under fleet/tentacles/. */
  id: string;
  /** Human-facing terminal display name. */
  name: string;
  /** Parent role id, or null for the single fleet root (e.g. the CEO). */
  parentRoleId: string | null;
  /** Standing C-suite roles are `shared` (vault-wide reads); specialists are `worktree`. */
  workspaceMode: FleetWorkspaceMode;
  /** Prompt template name resolved against the octogent prompts directory. */
  promptTemplate: string;
  /** One-line domain description used when registering the tentacle. */
  description?: string;
  /** Symbolic path of the canonical persona this role's CONTEXT.md was seeded from. */
  personaSource?: string;
  /** Engine for this node's sessions (Org v2.1 policy: officers "claude-code", build profiles "codex"). Omitted → runtime default. */
  agentProvider?: TerminalAgentProvider;
};

export type FleetSpecialistPolicy = {
  workspaceMode: FleetWorkspaceMode;
  promptTemplate: string;
  ephemeral: boolean;
  /** Repo-relative path of the Claude settings deny-template staged into specialist worktrees. */
  claudeSettingsTemplate?: string;
};

export type FleetProfileKind = "profile" | "bound-service";

export type FleetProfileDefinition = {
  /** Stable dormant terminal/tentacle identity. */
  id: string;
  /** Human-facing terminal display name. */
  name: string;
  /** Owning standing role. Profiles may never parent other profiles. */
  parentRoleId: string;
  /** Prompt template resolved by the API-side runner before registration. */
  promptTemplate: string;
  /** Repo-relative seed folder copied into runtime state. */
  seedDir: string;
  /** Bound services are represented in the UI but are never Claude sessions. */
  kind: FleetProfileKind;
  /** Engine used when this profile is woken. Forbidden on bound-service (never a session). */
  agentProvider?: TerminalAgentProvider;
};

export type FleetManifest = {
  version: 2;
  fleetId: string;
  roles: FleetRoleDefinition[];
  profiles: FleetProfileDefinition[];
  specialists?: FleetSpecialistPolicy;
};

export type FleetSpawnStep = {
  /** 0-based position; parents always precede their children. */
  order: number;
  roleId: string;
  name: string;
  parentRoleId: string | null;
  workspaceMode: FleetWorkspaceMode;
  promptTemplate: string;
  description: string;
  agentProvider?: TerminalAgentProvider;
};

export type FleetProfileRecordRequest = {
  profileId: string;
  kind: FleetProfileKind;
  requestBody: {
    name: string;
    workspaceMode: "shared";
    tentacleId: string;
    parentTerminalId: string;
    initialInputDraft: string;
    agentProvider?: TerminalAgentProvider;
    metadata: {
      fleetId: string;
      fleetProfileId: string;
      fleetProfileKind: FleetProfileKind;
      promptTemplate: string;
      seedDir: string;
    };
  };
};

export class FleetManifestError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid fleet manifest:\n- ${issues.join("\n- ")}`);
    this.name = "FleetManifestError";
    this.issues = issues;
  }
}

const KEBAB_CASE_ID = /^[a-z][a-z0-9-]*$/;
const WORKSPACE_MODES: ReadonlySet<string> = new Set(["shared", "worktree"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const collectRoleIssues = (role: Record<string, unknown>, label: string): string[] => {
  const issues: string[] = [];
  if (!isNonEmptyString(role.id) || !KEBAB_CASE_ID.test(role.id)) {
    issues.push(`${label}: "id" must be a kebab-case string (got ${JSON.stringify(role.id)})`);
  }
  if (!isNonEmptyString(role.name)) {
    issues.push(`${label}: "name" must be a non-empty string`);
  }
  if (role.parentRoleId !== null && !isNonEmptyString(role.parentRoleId)) {
    issues.push(`${label}: "parentRoleId" must be a role id or null`);
  }
  if (!isNonEmptyString(role.workspaceMode) || !WORKSPACE_MODES.has(role.workspaceMode)) {
    issues.push(`${label}: "workspaceMode" must be "shared" or "worktree"`);
  }
  if (!isNonEmptyString(role.promptTemplate)) {
    issues.push(`${label}: "promptTemplate" must be a non-empty string`);
  }
  if (role.agentProvider !== undefined && !isTerminalAgentProvider(role.agentProvider)) {
    issues.push(
      `${label}: "agentProvider" must be "codex" or "claude-code" when present (got ${JSON.stringify(role.agentProvider)})`,
    );
  }
  return issues;
};

const collectProfileIssues = (profile: Record<string, unknown>, label: string): string[] => {
  const issues: string[] = [];
  if (!isNonEmptyString(profile.id) || !KEBAB_CASE_ID.test(profile.id)) {
    issues.push(`${label}: "id" must be a kebab-case string (got ${JSON.stringify(profile.id)})`);
  }
  if (!isNonEmptyString(profile.name)) {
    issues.push(`${label}: "name" must be a non-empty string`);
  }
  if (!isNonEmptyString(profile.parentRoleId)) {
    issues.push(`${label}: "parentRoleId" must be a role id`);
  }
  if (!isNonEmptyString(profile.promptTemplate)) {
    issues.push(`${label}: "promptTemplate" must be a non-empty string`);
  }
  if (!isNonEmptyString(profile.seedDir)) {
    issues.push(`${label}: "seedDir" must be a non-empty string`);
  }
  if (profile.kind !== "profile" && profile.kind !== "bound-service") {
    issues.push(`${label}: "kind" must be "profile" or "bound-service"`);
  }
  if (profile.agentProvider !== undefined && !isTerminalAgentProvider(profile.agentProvider)) {
    issues.push(
      `${label}: "agentProvider" must be "codex" or "claude-code" when present (got ${JSON.stringify(profile.agentProvider)})`,
    );
  }
  if (profile.kind === "bound-service" && profile.agentProvider !== undefined) {
    issues.push(
      `${label}: bound-service profiles never run sessions; "agentProvider" is forbidden`,
    );
  }
  return issues;
};

const collectTreeIssues = (
  roles: FleetRoleDefinition[],
  maxChildrenPerParent: number,
): string[] => {
  const issues: string[] = [];
  const idCounts = new Map<string, number>();
  for (const role of roles) {
    idCounts.set(role.id, (idCounts.get(role.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push(`duplicate role id "${id}" (${count} occurrences)`);
    }
  }

  const roots = roles.filter((role) => role.parentRoleId === null);
  if (roots.length !== 1) {
    issues.push(
      `fleet must have exactly one root role (parentRoleId: null); found ${roots.length}`,
    );
  }

  const knownIds = new Set(idCounts.keys());
  const childCounts = new Map<string, number>();
  for (const role of roles) {
    if (role.parentRoleId === null) continue;
    if (role.parentRoleId === role.id) {
      issues.push(`role "${role.id}" cannot be its own parent`);
      continue;
    }
    if (!knownIds.has(role.parentRoleId)) {
      issues.push(`role "${role.id}" references unknown parent "${role.parentRoleId}"`);
      continue;
    }
    childCounts.set(role.parentRoleId, (childCounts.get(role.parentRoleId) ?? 0) + 1);
  }

  for (const [parentId, count] of childCounts) {
    if (count > maxChildrenPerParent) {
      issues.push(
        `role "${parentId}" has ${count} children; ` +
          `runtime cap is ${maxChildrenPerParent} (MAX_CHILDREN_PER_PARENT)`,
      );
    }
  }

  // Cycle / unreachable detection via BFS from the root (only meaningful with one root).
  if (roots.length === 1 && issues.length === 0) {
    const root = roots[0];
    if (root) {
      const reachable = new Set<string>([root.id]);
      let frontier = [root.id];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const role of roles) {
          const parentInFrontier =
            role.parentRoleId !== null && frontier.includes(role.parentRoleId);
          if (parentInFrontier && !reachable.has(role.id)) {
            reachable.add(role.id);
            next.push(role.id);
          }
        }
        frontier = next;
      }
      for (const role of roles) {
        if (!reachable.has(role.id)) {
          issues.push(`role "${role.id}" is not reachable from the root (cycle or orphan)`);
        }
      }
    }
  }

  return issues;
};

/**
 * Parse and validate a raw manifest (e.g. JSON.parse of fleet/fleet.json).
 * Throws FleetManifestError listing every issue found.
 */
export const parseFleetManifest = (
  raw: unknown,
  options?: { maxChildrenPerParent?: number },
): FleetManifest => {
  const maxChildren = options?.maxChildrenPerParent ?? DEFAULT_FLEET_MAX_CHILDREN_PER_PARENT;
  const issues: string[] = [];

  if (!isRecord(raw)) {
    throw new FleetManifestError(["manifest must be a JSON object"]);
  }
  if (raw.version !== 2) {
    issues.push(`unsupported manifest version ${JSON.stringify(raw.version)} (expected 2)`);
  }
  if (!isNonEmptyString(raw.fleetId) || !KEBAB_CASE_ID.test(raw.fleetId)) {
    issues.push(`"fleetId" must be a kebab-case string`);
  }
  if (!Array.isArray(raw.roles) || raw.roles.length === 0) {
    issues.push(`"roles" must be a non-empty array`);
    throw new FleetManifestError(issues);
  }

  const roleRecords: Record<string, unknown>[] = [];
  for (const [index, role] of raw.roles.entries()) {
    if (!isRecord(role)) {
      issues.push(`roles[${index}] must be an object`);
      continue;
    }
    const label = isNonEmptyString(role.id) ? `role "${role.id}"` : `roles[${index}]`;
    issues.push(...collectRoleIssues(role, label));
    roleRecords.push(role);
  }

  if (issues.length > 0) {
    throw new FleetManifestError(issues);
  }

  const roles: FleetRoleDefinition[] = roleRecords.map((role) => ({
    id: role.id as string,
    name: role.name as string,
    parentRoleId: (role.parentRoleId as string | null) ?? null,
    workspaceMode: role.workspaceMode as FleetWorkspaceMode,
    promptTemplate: role.promptTemplate as string,
    ...(isNonEmptyString(role.description) ? { description: role.description } : {}),
    ...(isNonEmptyString(role.personaSource) ? { personaSource: role.personaSource } : {}),
    ...(isTerminalAgentProvider(role.agentProvider) ? { agentProvider: role.agentProvider } : {}),
  }));

  issues.push(...collectTreeIssues(roles, maxChildren));

  if (!Array.isArray(raw.profiles)) {
    issues.push(`"profiles" must be an array`);
  }

  const profileRecords: Record<string, unknown>[] = [];
  if (Array.isArray(raw.profiles)) {
    for (const [index, profile] of raw.profiles.entries()) {
      if (!isRecord(profile)) {
        issues.push(`profiles[${index}] must be an object`);
        continue;
      }
      const label = isNonEmptyString(profile.id) ? `profile "${profile.id}"` : `profiles[${index}]`;
      issues.push(...collectProfileIssues(profile, label));
      profileRecords.push(profile);
    }
  }

  const profiles: FleetProfileDefinition[] = profileRecords
    .filter(
      (profile) =>
        isNonEmptyString(profile.id) &&
        isNonEmptyString(profile.name) &&
        isNonEmptyString(profile.parentRoleId) &&
        isNonEmptyString(profile.promptTemplate) &&
        isNonEmptyString(profile.seedDir) &&
        (profile.kind === "profile" || profile.kind === "bound-service"),
    )
    .map((profile) => ({
      id: profile.id as string,
      name: profile.name as string,
      parentRoleId: profile.parentRoleId as string,
      promptTemplate: profile.promptTemplate as string,
      seedDir: profile.seedDir as string,
      kind: profile.kind as FleetProfileKind,
      ...(isTerminalAgentProvider(profile.agentProvider)
        ? { agentProvider: profile.agentProvider }
        : {}),
    }));

  const roleIds = new Set(roles.map((role) => role.id));
  const profileIdCounts = new Map<string, number>();
  for (const profile of profileRecords) {
    const profileId = isNonEmptyString(profile.id) ? profile.id : undefined;
    const parentRoleId = isNonEmptyString(profile.parentRoleId) ? profile.parentRoleId : undefined;
    if (profileId) {
      profileIdCounts.set(profileId, (profileIdCounts.get(profileId) ?? 0) + 1);
    }
    if (profileId && roleIds.has(profileId)) {
      issues.push(`profile id "${profileId}" conflicts with a role id`);
    }
    if (profileId && parentRoleId && !roleIds.has(parentRoleId)) {
      issues.push(`profile "${profileId}" references unknown parent role "${parentRoleId}"`);
    }
  }
  for (const [id, count] of profileIdCounts) {
    if (count > 1) {
      issues.push(`duplicate profile id "${id}" (${count} occurrences)`);
    }
  }

  let specialists: FleetSpecialistPolicy | undefined;
  if (raw.specialists !== undefined) {
    if (!isRecord(raw.specialists)) {
      issues.push(`"specialists" must be an object when present`);
    } else {
      const policy = raw.specialists;
      if (!isNonEmptyString(policy.workspaceMode) || !WORKSPACE_MODES.has(policy.workspaceMode)) {
        issues.push(`specialists: "workspaceMode" must be "shared" or "worktree"`);
      }
      if (!isNonEmptyString(policy.promptTemplate)) {
        issues.push(`specialists: "promptTemplate" must be a non-empty string`);
      }
      if (typeof policy.ephemeral !== "boolean") {
        issues.push(`specialists: "ephemeral" must be a boolean`);
      }
      if (issues.length === 0) {
        specialists = {
          workspaceMode: policy.workspaceMode as FleetWorkspaceMode,
          promptTemplate: policy.promptTemplate as string,
          ephemeral: policy.ephemeral as boolean,
          ...(isNonEmptyString(policy.claudeSettingsTemplate)
            ? { claudeSettingsTemplate: policy.claudeSettingsTemplate }
            : {}),
        };
      }
    }
  }

  if (issues.length > 0) {
    throw new FleetManifestError(issues);
  }

  return {
    version: 2,
    fleetId: raw.fleetId as string,
    roles,
    profiles,
    ...(specialists ? { specialists } : {}),
  };
};

/**
 * Derive the deterministic spawn order: breadth-first from the root, siblings in
 * manifest order. Guarantees every parent's step precedes all of its children so the
 * runner can capture the parent terminalId before spawning the child.
 */
export const buildFleetSpawnPlan = (manifest: FleetManifest): FleetSpawnStep[] => {
  const steps: FleetSpawnStep[] = [];
  const root = manifest.roles.find((role) => role.parentRoleId === null);
  if (!root) {
    throw new FleetManifestError(["fleet has no root role; parse the manifest first"]);
  }

  let frontier = [root];
  while (frontier.length > 0) {
    const next: FleetRoleDefinition[] = [];
    for (const role of frontier) {
      steps.push({
        order: steps.length,
        roleId: role.id,
        name: role.name,
        parentRoleId: role.parentRoleId,
        workspaceMode: role.workspaceMode,
        promptTemplate: role.promptTemplate,
        description: role.description ?? "",
        ...(role.agentProvider ? { agentProvider: role.agentProvider } : {}),
      });
      next.push(...manifest.roles.filter((candidate) => candidate.parentRoleId === role.id));
    }
    frontier = next;
  }

  return steps;
};

/**
 * Build register-only terminal create requests for every profile. The API-side caller
 * resolves prompt templates first and supplies the resulting charters here. Requests
 * deliberately contain `initialInputDraft`, never `initialPrompt`, so creating the
 * dormant UI record cannot auto-start a PTY. Bound services receive the same dormant
 * representation record and are fenced from wake by their persisted metadata.
 */
export const buildProfileRecords = (
  manifest: FleetManifest,
  options: {
    parentTerminalIds: Readonly<Record<string, string>>;
    resolvedCharters: Readonly<Record<string, string>>;
  },
): FleetProfileRecordRequest[] =>
  manifest.profiles.map((profile) => {
    const parentTerminalId = options.parentTerminalIds[profile.parentRoleId]?.trim();
    if (!parentTerminalId) {
      throw new FleetManifestError([
        `profile "${profile.id}" has no resolved parent terminal for role "${profile.parentRoleId}"`,
      ]);
    }

    const initialInputDraft = options.resolvedCharters[profile.id]?.trim();
    if (!initialInputDraft) {
      throw new FleetManifestError([`profile "${profile.id}" has no resolved charter`]);
    }

    return {
      profileId: profile.id,
      kind: profile.kind,
      requestBody: {
        name: profile.name,
        workspaceMode: "shared",
        tentacleId: profile.id,
        parentTerminalId,
        initialInputDraft,
        ...(profile.agentProvider ? { agentProvider: profile.agentProvider } : {}),
        metadata: {
          fleetId: manifest.fleetId,
          fleetProfileId: profile.id,
          fleetProfileKind: profile.kind,
          promptTemplate: profile.promptTemplate,
          seedDir: profile.seedDir,
        },
      },
    };
  });
