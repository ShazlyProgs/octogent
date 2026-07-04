import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseFleetManifest } from "@octogent/core";
import { describe, expect, it } from "vitest";

import {
  buildStageActions,
  buildTentacleRegistrations,
  buildTerminalRequests,
  loadFleetManifest,
  resolveDefaultStateDir,
} from "../src/fleetSpawn";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..", "..");

const manifest = () =>
  parseFleetManifest({
    version: 1,
    fleetId: "csuite",
    roles: [
      {
        id: "fleet-ceo",
        name: "CEO",
        parentRoleId: null,
        workspaceMode: "shared",
        promptTemplate: "csuite-agent-init",
        description: "Root",
      },
      {
        id: "fleet-cto",
        name: "CTO",
        parentRoleId: "fleet-ceo",
        workspaceMode: "shared",
        promptTemplate: "csuite-agent-init",
        description: "Tech",
      },
    ],
  });

describe("loadFleetManifest", () => {
  it("loads and validates the real shipped manifest", () => {
    const shipped = loadFleetManifest(PACKAGE_ROOT);
    expect(shipped.fleetId).toBe("csuite");
    expect(shipped.roles.length).toBe(7);
    const root = shipped.roles.filter((role) => role.parentRoleId === null);
    expect(root.map((role) => role.id)).toEqual(["fleet-ceo"]);
    // Every shipped role must have a staged seed folder with the three seed files.
    for (const role of shipped.roles) {
      for (const file of ["CONTEXT.md", "todo.md", "memory.md"]) {
        const seedPath = join(PACKAGE_ROOT, "fleet", "tentacles", role.id, file);
        expect(existsSync(seedPath), `missing seed file ${seedPath}`).toBe(true);
      }
    }
  });

  it("ships a specialist policy pointing at the D5 deny template", () => {
    const shipped = loadFleetManifest(PACKAGE_ROOT);
    expect(shipped.specialists).toMatchObject({
      workspaceMode: "worktree",
      promptTemplate: "tentacle-spawn",
      ephemeral: true,
      claudeSettingsTemplate: "fleet/worktree-claude-settings.json",
    });
  });
});

describe("D5 worktree deny template", () => {
  it("hard-denies git push and secret reads", () => {
    const templatePath = join(PACKAGE_ROOT, "fleet", "worktree-claude-settings.json");
    const template = JSON.parse(readFileSync(templatePath, "utf8")) as {
      permissions?: { deny?: string[] };
    };
    const deny = template.permissions?.deny ?? [];
    expect(deny).toContain("Bash(git push:*)");
    expect(deny).toContain("Bash(git push*)");
    expect(deny).toContain("Read(**/.env)");
    expect(deny).toContain("Read(**/id_ed25519*)");
    // Delta vs the legacy engine: commit stays ALLOWED for octogent-native workers.
    expect(deny.some((rule) => rule.includes("git commit"))).toBe(false);
  });
});

describe("buildStageActions", () => {
  it("derives copy targets under the state dir and skips existing folders", () => {
    const actions = buildStageActions(manifest(), {
      packageRoot: "C:/octogent",
      stateDir: "C:/repos/.octogent",
      targetExists: (path) => path.includes("fleet-ceo"),
    });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ roleId: "fleet-ceo", shouldCopy: false });
    expect(actions[1]).toMatchObject({ roleId: "fleet-cto", shouldCopy: true });
    expect(actions[1]?.sourceDir).toBe(join("C:/octogent", "fleet", "tentacles", "fleet-cto"));
    expect(actions[1]?.targetDir).toBe(join("C:/repos/.octogent", "tentacles", "fleet-cto"));
  });
});

describe("buildTentacleRegistrations", () => {
  it("registers each role by id with its description", () => {
    const registrations = buildTentacleRegistrations(manifest());
    expect(registrations).toEqual([
      { roleId: "fleet-ceo", requestBody: { name: "fleet-ceo", description: "Root" } },
      { roleId: "fleet-cto", requestBody: { name: "fleet-cto", description: "Tech" } },
    ]);
  });
});

describe("buildTerminalRequests", () => {
  it("orders parent before child and shapes the terminal create bodies", () => {
    const requests = buildTerminalRequests(manifest(), {
      stateDir: "C:/repos/.octogent",
      bossTerminalId: "terminal-1",
    });
    expect(requests.map((request) => request.roleId)).toEqual(["fleet-ceo", "fleet-cto"]);

    const root = requests[0];
    expect(root?.parentRoleId).toBeNull();
    expect(root?.requestBody).toMatchObject({
      name: "CEO",
      workspaceMode: "shared",
      tentacleId: "fleet-ceo",
      promptTemplate: "csuite-agent-init",
    });
    expect(root?.requestBody.promptVariables).toMatchObject({
      roleName: "CEO",
      roleId: "fleet-ceo",
      fleetId: "csuite",
      parentTerminalId: "terminal-1",
      tentacleContextPath: join("C:/repos/.octogent", "tentacles", "fleet-ceo"),
    });

    const child = requests[1];
    expect(child?.parentRoleId).toBe("fleet-ceo");
    // The live parent terminal id is resolved at spawn time by the executor.
    expect(child?.requestBody.promptVariables.parentTerminalId).toBe("");
  });

  it("leaves the root parent empty when no boss terminal is supplied", () => {
    const requests = buildTerminalRequests(manifest(), { stateDir: "C:/s" });
    expect(requests[0]?.requestBody.promptVariables.parentTerminalId).toBe("");
  });
});

describe("resolveDefaultStateDir", () => {
  it("resolves $STATE two levels above the octogent repo per REPOS.md", () => {
    expect(resolveDefaultStateDir("C:/repos/Agents/octogent")).toBe(
      resolve("C:/repos/Agents/octogent", "..", "..", ".octogent"),
    );
  });
});
