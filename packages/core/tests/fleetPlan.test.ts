import { describe, expect, it } from "vitest";

import {
  FleetManifestError,
  buildFleetSpawnPlan,
  parseFleetManifest,
} from "../src/application/fleetPlan";

const validManifest = () => ({
  version: 1,
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
    expect(manifest.specialists?.ephemeral).toBe(true);
    expect(manifest.specialists?.claudeSettingsTemplate).toBe(
      "fleet/worktree-claude-settings.json",
    );
  });

  it("rejects a non-object manifest", () => {
    expect(() => parseFleetManifest("nope")).toThrowError(FleetManifestError);
  });

  it("rejects an unsupported version", () => {
    const raw = { ...validManifest(), version: 2 };
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
