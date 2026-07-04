/**
 * Fleet plan — pure domain logic for the standing C-suite fleet (#45 W-ORCH-NATIVE Phase 1).
 *
 * A fleet manifest declares an org-chart tree of STANDING tentacles (rulings D1/D2:
 * C-suite = standing tentacles, 24/7) plus a policy block for EPHEMERAL specialist
 * worktree subagents (rulings D1/D5). This module validates the manifest and derives
 * a deterministic parent-before-child spawn order. It performs no I/O — staging and
 * API calls live in the api app (ports-and-adapters boundary).
 */

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
};

export type FleetSpecialistPolicy = {
  workspaceMode: FleetWorkspaceMode;
  promptTemplate: string;
  ephemeral: boolean;
  /** Repo-relative path of the Claude settings deny-template staged into specialist worktrees. */
  claudeSettingsTemplate?: string;
};

export type FleetManifest = {
  version: 1;
  fleetId: string;
  roles: FleetRoleDefinition[];
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
  if (raw.version !== 1) {
    issues.push(`unsupported manifest version ${JSON.stringify(raw.version)} (expected 1)`);
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
  }));

  issues.push(...collectTreeIssues(roles, maxChildren));

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
    version: 1,
    fleetId: raw.fleetId as string,
    roles,
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
      });
      next.push(...manifest.roles.filter((candidate) => candidate.parentRoleId === role.id));
    }
    frontier = next;
  }

  return steps;
};
