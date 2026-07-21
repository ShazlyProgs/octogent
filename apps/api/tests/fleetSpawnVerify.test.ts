import { parseFleetManifest } from "@octogent/core";
import { describe, expect, it, vi } from "vitest";

import {
  type FleetVerifyArtifact,
  FleetVerifyBlockedError,
  buildFleetSpawnVerifyDescriptor,
  runFleetSpawnVerify,
} from "../src/fleetSpawn";

const manifest = () =>
  parseFleetManifest({
    version: 2,
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
    profiles: [],
  });

const spawned = () =>
  new Map<string, string>([
    ["fleet-ceo", "terminal-1"],
    ["fleet-cto", "terminal-2"],
  ]);

describe("buildFleetSpawnVerifyDescriptor", () => {
  it("describes the spawn with terminal-id evidence, a claim, and a scope fence", () => {
    const descriptor = buildFleetSpawnVerifyDescriptor(manifest(), spawned());
    expect(descriptor.title).toContain("csuite");
    expect(descriptor.claim).toContain("2 standing");
    expect(descriptor.claim).toContain("parent-before-child");
    // scope must fence out specialists + back-office mutation (guards scope creep)
    expect(descriptor.scope).toContain("NOT specialist worktrees");
    // one evidence item per spawned tentacle, carrying its terminal id
    expect(descriptor.evidence).toHaveLength(2);
    expect(descriptor.evidence?.[0]).toMatchObject({ kind: "terminal" });
    expect(descriptor.evidence?.[0]?.reference).toContain("terminal-1");
    expect(descriptor.evidence?.[1]?.reference).toContain("terminal-2");
    // context names the expected root so the auditor can catch a wrong tree
    expect(descriptor.context).toContain("fleet-ceo");
  });
});

describe("runFleetSpawnVerify", () => {
  it("records a PENDING artifact and does not block when no producer is supplied", async () => {
    const record = vi.fn<(a: FleetVerifyArtifact) => void>();
    const artifact = await runFleetSpawnVerify(manifest(), spawned(), { enabled: true, record });

    expect(artifact.status).toBe("pending");
    expect(artifact.verdict).toBeNull();
    expect(artifact.decision).toBeNull();
    expect(artifact.fleetId).toBe("csuite");
    expect(artifact.spawnedRoleIds).toEqual(["fleet-ceo", "fleet-cto"]);
    expect(artifact.prompt).toContain("ADVERSARIAL VERIFIER");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toBe(artifact);
  });

  it("records PASSED on an APPROVE verdict", async () => {
    const record = vi.fn<(a: FleetVerifyArtifact) => void>();
    const artifact = await runFleetSpawnVerify(manifest(), spawned(), {
      enabled: true,
      record,
      produceVerdict: () => ({ verdict: "APPROVE", mustFix: [], notes: "all live" }),
    });

    expect(artifact.status).toBe("passed");
    expect(artifact.verdict?.verdict).toBe("APPROVE");
    expect(artifact.decision?.blocked).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("records the artifact AND throws FleetVerifyBlockedError on a REJECT verdict", async () => {
    const record = vi.fn<(a: FleetVerifyArtifact) => void>();
    await expect(
      runFleetSpawnVerify(manifest(), spawned(), {
        enabled: true,
        record,
        produceVerdict: () => ({
          verdict: "REJECT",
          mustFix: ["fleet-cto has no terminal id (orphaned child)"],
          notes: "",
        }),
      }),
    ).rejects.toThrow(FleetVerifyBlockedError);

    // The blocked artifact is still recorded (audit trail), before the throw.
    expect(record).toHaveBeenCalledTimes(1);
    const recorded = record.mock.calls[0]?.[0];
    expect(recorded?.status).toBe("blocked");
    expect(recorded?.decision?.reason).toContain("orphaned child");
  });

  it("blocks on APPROVE_WITH_FIXES only when blockOnFixes is set", async () => {
    const record = vi.fn<(a: FleetVerifyArtifact) => void>();
    const verdict = () => ({
      verdict: "APPROVE_WITH_FIXES",
      mustFix: ["rename fleet-cto"],
      notes: "",
    });

    const passed = await runFleetSpawnVerify(manifest(), spawned(), {
      enabled: true,
      record,
      produceVerdict: verdict,
    });
    expect(passed.status).toBe("passed");

    await expect(
      runFleetSpawnVerify(manifest(), spawned(), {
        enabled: true,
        record,
        blockOnFixes: true,
        produceVerdict: verdict,
      }),
    ).rejects.toThrow(FleetVerifyBlockedError);
  });
});
