import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFleetManifest } from "@octogent/core";
import { describe, expect, it, vi } from "vitest";

import {
  type FleetVerifyArtifact,
  FleetVerifyBlockedError,
  appendFleetVerifyArtifact,
  buildFleetSpawnVerifyDescriptor,
  runFleetSpawnVerify,
} from "../src/fleetSpawn";
import {
  FleetVerdictProducerError,
  createFleetVerdictProducer,
  surfaceFleetVerifyArtifact,
} from "../src/fleetVerifyRuntime";

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
    expect(artifact.outcome).toBe("pending");
    expect(artifact.verdict).toBeNull();
    expect(artifact.decision).toBeNull();
    expect(artifact.tracePointer).toBeNull();
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

  it("does not accept a work product when the parent notification fails", async () => {
    const record = vi.fn<(a: FleetVerifyArtifact) => void>();
    const surface = vi.fn(async () => {
      throw new Error("parent channel unavailable");
    });

    await expect(
      runFleetSpawnVerify(manifest(), spawned(), {
        enabled: true,
        record,
        surface,
        produceVerdict: () => ({ verdict: "APPROVE", mustFix: [], notes: "all live" }),
      }),
    ).rejects.toThrow("parent channel unavailable");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("persists the live producer trace pointer and surfaces PASS to the parent", async () => {
    const record = vi.fn<(a: FleetVerifyArtifact) => void>();
    const surface = vi.fn<(a: FleetVerifyArtifact) => void>();
    const artifact = await runFleetSpawnVerify(manifest(), spawned(), {
      enabled: true,
      record,
      surface,
      produceVerdict: () => ({
        rawVerdict: { verdict: "APPROVE", mustFix: [], notes: "all live" },
        tracePointer: "state/transcripts/verifier-1.jsonl",
        verifierTerminalId: "verifier-1",
      }),
    });

    expect(artifact.outcome).toBe("pass");
    expect(artifact.tracePointer).toBe("state/transcripts/verifier-1.jsonl");
    expect(artifact.verifierTerminalId).toBe("verifier-1");
    expect(surface).toHaveBeenCalledWith(artifact, {
      fleetId: "csuite",
      parentTerminalId: "terminal-1",
    });
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
    expect(recorded?.outcome).toBe("fail");
    expect(recorded?.decision?.reason).toContain("orphaned child");
    expect(recorded?.verdict?.notes).toBe("");
  });

  it("records and surfaces a producer failure as a blocked work product", async () => {
    const record = vi.fn<(a: FleetVerifyArtifact) => void>();
    const surface = vi.fn<(a: FleetVerifyArtifact) => void>();

    await expect(
      runFleetSpawnVerify(manifest(), spawned(), {
        enabled: true,
        record,
        surface,
        produceVerdict: () => {
          throw new FleetVerdictProducerError("verifier timed out", {
            tracePointer: "state/transcripts/verifier-timeout.jsonl",
            verifierTerminalId: "verifier-timeout",
          });
        },
      }),
    ).rejects.toThrow(FleetVerifyBlockedError);

    expect(record).toHaveBeenCalledTimes(1);
    const artifact = record.mock.calls[0]?.[0];
    expect(artifact?.status).toBe("blocked");
    expect(artifact?.outcome).toBe("fail");
    expect(artifact?.verdict).toBeNull();
    expect(artifact?.error).toContain("verifier timed out");
    expect(artifact?.tracePointer).toBe("state/transcripts/verifier-timeout.jsonl");
    expect(artifact?.verifierTerminalId).toBe("verifier-timeout");
    expect(surface).toHaveBeenCalledWith(artifact, {
      fleetId: "csuite",
      parentTerminalId: "terminal-1",
    });
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

describe("fleet verify persistence", () => {
  it("appends the pass/fail record with its full trace pointer", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "octogent-fleet-verify-"));
    const artifact = {
      fleetId: "csuite",
      spawnedRoleIds: ["fleet-ceo"],
      status: "passed",
      outcome: "pass",
      prompt: "full adversarial prompt",
      verdict: { verdict: "APPROVE", mustFix: [], notes: "checked" },
      decision: { blocked: false, verdict: "APPROVE", reason: "approved" },
      tracePointer: join(stateDir, "state", "transcripts", "verify-1.jsonl"),
      verifierTerminalId: "verify-1",
      error: null,
      at: "2026-07-21T20:00:00.000Z",
    } satisfies FleetVerifyArtifact;

    try {
      appendFleetVerifyArtifact(stateDir, artifact);
      const persisted = JSON.parse(
        readFileSync(join(stateDir, "fleet-verify.log.jsonl"), "utf8").trim(),
      ) as FleetVerifyArtifact;
      expect(persisted.outcome).toBe("pass");
      expect(persisted.prompt).toBe("full adversarial prompt");
      expect(persisted.tracePointer).toBe(artifact.tracePointer);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("live fleet verdict producer", () => {
  it("spawns a separate verifier, waits for its verdict, and points at the full transcript", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ terminalId: "verify-terminal-1" }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ turns: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            turns: [
              {
                turnId: "turn-1",
                role: "assistant",
                content: '{"verdict":"APPROVE","mustFix":[],"notes":"checked"}',
                startedAt: "2026-07-21T20:00:00.000Z",
                endedAt: "2026-07-21T20:00:01.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const wait = vi.fn(async () => undefined);
    const produceVerdict = createFleetVerdictProducer({
      apiBase: "http://127.0.0.1:8788",
      stateDir: "C:/fleet/.octogent",
      parentTerminalId: "ceo-terminal",
      fetch,
      wait,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });

    const production = await produceVerdict("audit this work product");

    expect(production).toMatchObject({
      rawVerdict: '{"verdict":"APPROVE","mustFix":[],"notes":"checked"}',
      verifierTerminalId: "verify-terminal-1",
    });
    expect(production.tracePointer.replaceAll("\\", "/")).toBe(
      "C:/fleet/.octogent/state/transcripts/verify-terminal-1.jsonl",
    );
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8788/api/terminals");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      parentTerminalId: "ceo-terminal",
      agentProvider: "claude-code",
      initialPrompt: "audit this work product",
    });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(
      "http://127.0.0.1:8788/api/terminals/verify-terminal-1",
    );
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  it("posts a compact verdict notification to the parent channel", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ messageId: "msg-1" }), { status: 201 }));
    const artifact = {
      fleetId: "csuite",
      spawnedRoleIds: ["fleet-ceo"],
      status: "blocked",
      outcome: "fail",
      prompt: "full prompt",
      verdict: { verdict: "REJECT", mustFix: ["orphan"], notes: "checked" },
      decision: { blocked: true, verdict: "REJECT", reason: "orphan" },
      tracePointer: "C:/fleet/.octogent/state/transcripts/verify-1.jsonl",
      verifierTerminalId: "verify-1",
      error: null,
      at: "2026-07-21T20:00:00.000Z",
    } satisfies FleetVerifyArtifact;

    await surfaceFleetVerifyArtifact({
      apiBase: "http://127.0.0.1:8788",
      parentTerminalId: "ceo-terminal",
      artifact,
      fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8788/api/channels/ceo-terminal/messages",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      fromTerminalId: "verify-1",
      content:
        '[VERIFY FAIL] fleet "csuite" standing spawn: REJECT. Must fix: orphan. Full trace: C:/fleet/.octogent/state/transcripts/verify-1.jsonl',
    });
  });
});
