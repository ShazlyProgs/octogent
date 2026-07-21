import { describe, expect, it } from "vitest";

import {
  FleetManifestError,
  buildFleetSpawnPlan,
  buildProfileRecords,
  parseFleetManifest,
} from "../src/application/fleetPlan";

const validManifest = () => ({
  version: 2,
  fleetId: "csuite",
  roles: [
    {
      id: "ceo",
      name: "CEO",
      parentRoleId: null,
      workspaceMode: "shared",
      promptTemplate: "csuite-agent-init",
      description: "Strategic root",
    },
    {
      id: "cto",
      name: "CTO",
      parentRoleId: "ceo",
      workspaceMode: "shared",
      promptTemplate: "csuite-agent-init",
    },
    {
      id: "cfo",
      name: "CFO",
      parentRoleId: "ceo",
      workspaceMode: "shared",
      promptTemplate: "csuite-agent-init",
    },
  ],
  profiles: [
    {
      id: "platform-engineer",
      name: "Platform Engineer",
      parentRoleId: "cto",
      promptTemplate: "csuite-agent-init",
      seedDir: "fleet/tentacles/platform-engineer",
      kind: "profile",
    },
    {
      id: "sara",
      name: "Sara",
      parentRoleId: "cfo",
      promptTemplate: "csuite-agent-init",
      seedDir: "fleet/tentacles/sara",
      kind: "bound-service",
    },
  ],
  specialists: {
    workspaceMode: "worktree",
    promptTemplate: "tentacle-spawn",
    ephemeral: true,
    claudeSettingsTemplate: "fleet/worktree-claude-settings.json",
  },
});

describe("parseFleetManifest", () => {
  it("accepts a valid manifest and normalizes optional fields", () => {
    const manifest = parseFleetManifest(validManifest());

    expect(manifest.fleetId).toBe("csuite");
    expect(manifest.roles).toHaveLength(3);
    expect(manifest.roles[0]?.description).toBe("Strategic root");
    expect(manifest.roles[1]?.description).toBeUndefined();
    expect(manifest.profiles.map((profile) => profile.id)).toEqual(["platform-engineer", "sara"]);
    expect(manifest.specialists?.ephemeral).toBe(true);
    expect(manifest.specialists?.claudeSettingsTemplate).toBe(
      "fleet/worktree-claude-settings.json",
    );
  });

  it("rejects a non-object manifest", () => {
    expect(() => parseFleetManifest("nope")).toThrowError(FleetManifestError);
  });

  it("rejects an unsupported version", () => {
    const raw = { ...validManifest(), version: 1 };
    expect(() => parseFleetManifest(raw)).toThrowError(/unsupported manifest version/);
  });

  it("rejects duplicate role ids", () => {
    const raw = validManifest();
    raw.roles.push({
      id: "cto",
      name: "CTO clone",
      parentRoleId: "ceo",
      workspaceMode: "shared",
      promptTemplate: "csuite-agent-init",
    });
    expect(() => parseFleetManifest(raw)).toThrowError(/duplicate role id "cto"/);
  });

  it("rejects a manifest without exactly one root", () => {
    const raw = validManifest();
    raw.roles.push({
      id: "second-root",
      name: "Second root",
      parentRoleId: null as unknown as string,
      workspaceMode: "shared",
      promptTemplate: "csuite-agent-init",
    });
    expect(() => parseFleetManifest(raw)).toThrowError(/exactly one root/);
  });

  it("rejects unknown parents and self-parents", () => {
    const raw = validManifest();
    raw.roles.push(
      {
        id: "ghost-child",
        name: "Ghost child",
        parentRoleId: "missing",
        workspaceMode: "shared",
        promptTemplate: "csuite-agent-init",
      },
      {
        id: "loner",
        name: "Loner",
        parentRoleId: "loner",
        workspaceMode: "shared",
        promptTemplate: "csuite-agent-init",
      },
    );
    try {
      parseFleetManifest(raw);
      expect.unreachable("expected FleetManifestError");
    } catch (error) {
      const issues = (error as FleetManifestError).issues.join("\n");
      expect(issues).toContain('references unknown parent "missing"');
      expect(issues).toContain('"loner" cannot be its own parent');
    }
  });

  it("rejects cycles that are unreachable from the root", () => {
    const raw = validManifest();
    raw.roles.push(
      {
        id: "cycle-a",
        name: "Cycle A",
        parentRoleId: "cycle-b",
        workspaceMode: "shared",
        promptTemplate: "csuite-agent-init",
      },
      {
        id: "cycle-b",
        name: "Cycle B",
        parentRoleId: "cycle-a",
        workspaceMode: "shared",
        promptTemplate: "csuite-agent-init",
      },
    );
    expect(() => parseFleetManifest(raw)).toThrowError(/not reachable from the root/);
  });

  it("enforces the runtime child cap per parent", () => {
    const raw = validManifest();
    for (let index = 0; index < 8; index += 1) {
      raw.roles.push({
        id: `extra-${index}`,
        name: `Extra ${index}`,
        parentRoleId: "ceo",
        workspaceMode: "shared",
        promptTemplate: "csuite-agent-init",
      });
    }
    // ceo now has 10 children (cto, cfo + 8 extras) against the default cap of 9.
    expect(() => parseFleetManifest(raw)).toThrowError(/runtime cap is 9/);
    expect(() => parseFleetManifest(raw, { maxChildrenPerParent: 10 })).not.toThrow();
  });

  it("rejects invalid workspace modes and empty prompt templates", () => {
    const raw = validManifest();
    raw.roles[1] = {
      ...raw.roles[1],
      workspaceMode: "floating",
      promptTemplate: "",
    } as (typeof raw.roles)[number];
    try {
      parseFleetManifest(raw);
      expect.unreachable("expected FleetManifestError");
    } catch (error) {
      const issues = (error as FleetManifestError).issues.join("\n");
      expect(issues).toContain('"workspaceMode" must be "shared" or "worktree"');
      expect(issues).toContain('"promptTemplate" must be a non-empty string');
    }
  });

  it("rejects invalid profiles and profile ids that collide with roles", () => {
    const raw = validManifest();
    raw.profiles.push(
      {
        id: "cto",
        name: "Role collision",
        parentRoleId: "ceo",
        promptTemplate: "csuite-agent-init",
        seedDir: "fleet/tentacles/cto-profile",
        kind: "profile",
      },
      {
        id: "orphan-profile",
        name: "Orphan",
        parentRoleId: "another-profile",
        promptTemplate: "",
        seedDir: "",
        kind: "service" as "profile",
      },
    );

    try {
      parseFleetManifest(raw);
      expect.unreachable("expected FleetManifestError");
    } catch (error) {
      const issues = (error as FleetManifestError).issues.join("\n");
      expect(issues).toContain('profile id "cto" conflicts with a role id');
      expect(issues).toContain('references unknown parent role "another-profile"');
      expect(issues).toContain('"promptTemplate" must be a non-empty string');
      expect(issues).toContain('"seedDir" must be a non-empty string');
      expect(issues).toContain('"kind" must be "profile" or "bound-service"');
    }
  });
});

describe("buildFleetSpawnPlan", () => {
  it("orders parents before children, siblings in manifest order", () => {
    const raw = validManifest();
    raw.roles.push({
      id: "testing-lead",
      name: "Testing lead",
      parentRoleId: "cto",
      workspaceMode: "shared",
      promptTemplate: "csuite-agent-init",
    });
    const plan = buildFleetSpawnPlan(parseFleetManifest(raw));

    expect(plan.map((step) => step.roleId)).toEqual(["ceo", "cto", "cfo", "testing-lead"]);
    expect(plan.some((step) => step.roleId === "sara")).toBe(false);
    expect(plan.map((step) => step.order)).toEqual([0, 1, 2, 3]);
    const child = plan.find((step) => step.roleId === "testing-lead");
    const parent = plan.find((step) => step.roleId === "cto");
    expect(parent && child && parent.order < child.order).toBe(true);
  });

  it("carries spawn fields through to the steps", () => {
    const plan = buildFleetSpawnPlan(parseFleetManifest(validManifest()));
    expect(plan[0]).toMatchObject({
      roleId: "ceo",
      name: "CEO",
      parentRoleId: null,
      workspaceMode: "shared",
      promptTemplate: "csuite-agent-init",
      description: "Strategic root",
    });
  });
});

describe("buildProfileRecords", () => {
  it("builds parent-linked dormant terminal create requests from resolved charters", () => {
    const records = buildProfileRecords(parseFleetManifest(validManifest()), {
      parentTerminalIds: { cto: "terminal-cto", cfo: "terminal-cfo" },
      resolvedCharters: {
        "platform-engineer": "Resolved platform charter",
        sara: "Resolved bound-service charter",
      },
    });

    expect(records).toEqual([
      {
        profileId: "platform-engineer",
        kind: "profile",
        requestBody: {
          name: "Platform Engineer",
          workspaceMode: "shared",
          tentacleId: "platform-engineer",
          parentTerminalId: "terminal-cto",
          initialInputDraft: "Resolved platform charter",
          metadata: {
            fleetId: "csuite",
            fleetProfileId: "platform-engineer",
            fleetProfileKind: "profile",
            promptTemplate: "csuite-agent-init",
            seedDir: "fleet/tentacles/platform-engineer",
          },
        },
      },
      {
        profileId: "sara",
        kind: "bound-service",
        requestBody: {
          name: "Sara",
          workspaceMode: "shared",
          tentacleId: "sara",
          parentTerminalId: "terminal-cfo",
          initialInputDraft: "Resolved bound-service charter",
          metadata: {
            fleetId: "csuite",
            fleetProfileId: "sara",
            fleetProfileKind: "bound-service",
            promptTemplate: "csuite-agent-init",
            seedDir: "fleet/tentacles/sara",
          },
        },
      },
    ]);
    expect(records.every((record) => !("initialPrompt" in record.requestBody))).toBe(true);
  });

  it("requires a parent terminal and resolved charter for every profile", () => {
    const manifest = parseFleetManifest(validManifest());
    expect(() =>
      buildProfileRecords(manifest, {
        parentTerminalIds: { cfo: "terminal-cfo" },
        resolvedCharters: { sara: "Sara charter" },
      }),
    ).toThrow(/platform-engineer.*parent terminal/i);
    expect(() =>
      buildProfileRecords(manifest, {
        parentTerminalIds: { cto: "terminal-cto", cfo: "terminal-cfo" },
        resolvedCharters: { sara: "Sara charter" },
      }),
    ).toThrow(/platform-engineer.*resolved charter/i);
  });
});

describe("agentProvider policy", () => {
  const manifestWithProviders = () => {
    const raw = validManifest();
    for (const role of raw.roles) {
      (role as Record<string, unknown>).agentProvider = "claude-code";
    }
    const profile = raw.profiles.find((candidate) => candidate.kind === "profile");
    (profile as Record<string, unknown>).agentProvider = "codex";
    return raw;
  };

  it("parses per-node providers and carries them into spawn steps and profile records", () => {
    const manifest = parseFleetManifest(manifestWithProviders());
    expect(manifest.roles.every((role) => role.agentProvider === "claude-code")).toBe(true);
    expect(manifest.profiles.find((profile) => profile.id === "platform-engineer")).toMatchObject({
      agentProvider: "codex",
    });
    expect(manifest.profiles.find((profile) => profile.id === "sara")?.agentProvider).toBe(
      undefined,
    );

    const plan = buildFleetSpawnPlan(manifest);
    expect(plan.every((step) => step.agentProvider === "claude-code")).toBe(true);

    const records = buildProfileRecords(manifest, {
      parentTerminalIds: { cto: "terminal-cto", cfo: "terminal-cfo" },
      resolvedCharters: {
        "platform-engineer": "Resolved platform charter",
        sara: "Resolved bound-service charter",
      },
    });
    expect(
      records.find((record) => record.profileId === "platform-engineer")?.requestBody,
    ).toMatchObject({ agentProvider: "codex" });
    expect(
      "agentProvider" in (records.find((record) => record.profileId === "sara")?.requestBody ?? {}),
    ).toBe(false);
  });

  it("rejects unknown role providers (GLM is a lane, not a provider)", () => {
    const raw = manifestWithProviders();
    (raw.roles[1] as Record<string, unknown>).agentProvider = "glm";
    expect(() => parseFleetManifest(raw)).toThrow(
      /"agentProvider" must be "codex" or "claude-code"/,
    );
  });

  it("rejects any provider on a bound-service", () => {
    const raw = manifestWithProviders();
    const sara = raw.profiles.find((candidate) => candidate.kind === "bound-service");
    (sara as Record<string, unknown>).agentProvider = "claude-code";
    expect(() => parseFleetManifest(raw)).toThrow(
      /bound-service profiles never run sessions; "agentProvider" is forbidden/,
    );
  });
});
