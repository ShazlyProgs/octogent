import { describe, expect, it, vi } from "vitest";

import {
  AUDIT_VERDICTS,
  VERIFY_VERDICT_JSON_SCHEMA,
  VerifyHarnessError,
  type VerifyVerdict,
  type WorkProductDescriptor,
  buildVerifyPrompt,
  evaluateVerifyGate,
  isAuditVerdict,
  parseVerifyVerdict,
  runAutoVerify,
} from "../src/application/verifyHarness";

const DESCRIPTOR: WorkProductDescriptor = {
  title: "cfo_report back-office tool",
  claim: "GET /api/cfo/report returns the finance report and is behind X-API-Key auth.",
  evidence: [
    { kind: "test", reference: "cfo-route.test.ts", detail: "6 tests pass" },
    { kind: "file", reference: "server/routes/cfo.ts" },
  ],
  scope: "read-only endpoint only; no WhatsApp side-effects",
  context: "mirrors the /cfo digest data",
};

describe("buildVerifyPrompt", () => {
  it("produces a refute-by-default prompt carrying title, claim, evidence, and scope", () => {
    const prompt = buildVerifyPrompt(DESCRIPTOR);
    expect(prompt).toContain("ADVERSARIAL VERIFIER");
    expect(prompt).toContain("REFUTE the claim");
    expect(prompt).toContain("Assume the work product is BROKEN");
    expect(prompt).toContain(DESCRIPTOR.title);
    expect(prompt).toContain(DESCRIPTOR.claim);
    // evidence rendered with index + kind
    expect(prompt).toContain("[test] cfo-route.test.ts — 6 tests pass");
    expect(prompt).toContain("[file] server/routes/cfo.ts");
    // scope fence + scope-creep instruction
    expect(prompt).toContain("In-scope fence");
    expect(prompt).toContain("scope creep");
    // the verdict schema is embedded verbatim
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain("APPROVE_WITH_FIXES");
  });

  it("flags absent evidence as unsupported (empty list is itself suspect)", () => {
    const prompt = buildVerifyPrompt({ title: "x", claim: "does y" });
    expect(prompt).toContain("none offered");
    expect(prompt).toContain("UNSUPPORTED");
    // optional sections omitted when absent
    expect(prompt).not.toContain("In-scope fence");
    expect(prompt).not.toContain("# Context");
  });

  it("throws when the descriptor lacks a title or claim (nothing to audit)", () => {
    expect(() => buildVerifyPrompt({ title: "", claim: "y" })).toThrow(VerifyHarnessError);
    expect(() => buildVerifyPrompt({ title: "x", claim: "  " })).toThrow(/non-empty claim/);
  });
});

describe("VERIFY_VERDICT_JSON_SCHEMA", () => {
  it("requires verdict/mustFix/notes and enumerates the verdict set", () => {
    expect(VERIFY_VERDICT_JSON_SCHEMA.required).toEqual(["verdict", "mustFix", "notes"]);
    expect(VERIFY_VERDICT_JSON_SCHEMA.properties.verdict.enum).toEqual([...AUDIT_VERDICTS]);
    expect(VERIFY_VERDICT_JSON_SCHEMA.properties.mustFix.type).toBe("array");
  });
});

describe("isAuditVerdict", () => {
  it("accepts the known verdicts and rejects anything else", () => {
    expect(isAuditVerdict("APPROVE")).toBe(true);
    expect(isAuditVerdict("REJECT")).toBe(true);
    expect(isAuditVerdict("MAYBE")).toBe(false);
    expect(isAuditVerdict(1)).toBe(false);
    expect(isAuditVerdict(undefined)).toBe(false);
  });
});

describe("parseVerifyVerdict", () => {
  it("accepts a valid verdict object", () => {
    const v = parseVerifyVerdict({
      verdict: "APPROVE_WITH_FIXES",
      mustFix: ["tighten the 503 reason"],
      notes: "re-ran the suite",
    });
    expect(v.verdict).toBe("APPROVE_WITH_FIXES");
    expect(v.mustFix).toEqual(["tighten the 503 reason"]);
    expect(v.notes).toBe("re-ran the suite");
  });

  it("parses a JSON string and defaults missing notes to empty", () => {
    const v = parseVerifyVerdict('{"verdict":"APPROVE","mustFix":[]}');
    expect(v.verdict).toBe("APPROVE");
    expect(v.mustFix).toEqual([]);
    expect(v.notes).toBe("");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseVerifyVerdict("{ not json")).toThrow(/not valid JSON/);
  });

  it("rejects a non-object", () => {
    expect(() => parseVerifyVerdict("[1,2,3]")).toThrow(/must be a JSON object/);
    expect(() => parseVerifyVerdict(42)).toThrow(VerifyHarnessError);
  });

  it("rejects an unknown verdict value", () => {
    expect(() => parseVerifyVerdict({ verdict: "LGTM", mustFix: [], notes: "" })).toThrow(
      /must be one of/,
    );
  });

  it("rejects a non-string-array mustFix", () => {
    expect(() => parseVerifyVerdict({ verdict: "REJECT", mustFix: "broken", notes: "" })).toThrow(
      /mustFix must be an array of strings/,
    );
    expect(() => parseVerifyVerdict({ verdict: "REJECT", mustFix: [1, 2], notes: "" })).toThrow(
      /array of strings/,
    );
  });

  it("rejects an APPROVE that still carries mustFix items (contradiction)", () => {
    expect(() =>
      parseVerifyVerdict({
        verdict: "APPROVE",
        mustFix: ["still broken"],
        notes: "",
      }),
    ).toThrow(/APPROVE cannot carry mustFix/);
  });
});

// --- D4 auto-run (gate + injectable orchestrator) --------------------------

const verdictOf = (verdict: VerifyVerdict["verdict"], mustFix: string[] = []): VerifyVerdict => ({
  verdict,
  mustFix,
  notes: "",
});

describe("evaluateVerifyGate", () => {
  it("blocks on REJECT and carries the mustFix list in the reason", () => {
    const d = evaluateVerifyGate(verdictOf("REJECT", ["path is stale", "test never ran"]));
    expect(d.blocked).toBe(true);
    expect(d.verdict).toBe("REJECT");
    expect(d.reason).toContain("REJECTED");
    expect(d.reason).toContain("path is stale");
    expect(d.reason).toContain("test never ran");
  });

  it("passes on APPROVE", () => {
    const d = evaluateVerifyGate(verdictOf("APPROVE"));
    expect(d.blocked).toBe(false);
    expect(d.reason).toContain("APPROVED");
  });

  it("passes APPROVE_WITH_FIXES by default but blocks when blockOnFixes is set", () => {
    const pass = evaluateVerifyGate(verdictOf("APPROVE_WITH_FIXES", ["tighten reason"]));
    expect(pass.blocked).toBe(false);
    expect(pass.reason).toContain("follow-up");

    const block = evaluateVerifyGate(verdictOf("APPROVE_WITH_FIXES", ["tighten reason"]), {
      blockOnFixes: true,
    });
    expect(block.blocked).toBe(true);
    expect(block.reason).toContain("blockOnFixes");
    expect(block.reason).toContain("tighten reason");
  });
});

describe("runAutoVerify", () => {
  const descriptor: WorkProductDescriptor = {
    title: "fleet spawn",
    claim: "stood up 2 tentacles parent-before-child",
  };

  it("returns pending with the prompt when no producer is supplied (never fabricates)", async () => {
    const result = await runAutoVerify(descriptor);
    expect(result.status).toBe("pending");
    expect(result.verdict).toBeNull();
    expect(result.decision).toBeNull();
    expect(result.prompt).toContain("ADVERSARIAL VERIFIER");
  });

  it("feeds the built prompt to the producer and passes on APPROVE", async () => {
    const produceVerdict = vi.fn(async () => ({ verdict: "APPROVE", mustFix: [], notes: "ok" }));
    const result = await runAutoVerify(descriptor, { produceVerdict });
    expect(produceVerdict).toHaveBeenCalledTimes(1);
    expect(produceVerdict.mock.calls[0]?.[0]).toContain("REFUTE the claim");
    expect(result.status).toBe("passed");
    expect(result.verdict?.verdict).toBe("APPROVE");
    expect(result.decision?.blocked).toBe(false);
  });

  it("blocks when the producer returns REJECT", async () => {
    const result = await runAutoVerify(descriptor, {
      produceVerdict: () => ({ verdict: "REJECT", mustFix: ["orphaned child"], notes: "" }),
    });
    expect(result.status).toBe("blocked");
    expect(result.decision?.blocked).toBe(true);
    expect(result.decision?.reason).toContain("orphaned child");
  });

  it("accepts a JSON-string verdict from the producer", async () => {
    const result = await runAutoVerify(descriptor, {
      produceVerdict: () => '{"verdict":"APPROVE","mustFix":[],"notes":""}',
    });
    expect(result.status).toBe("passed");
  });

  it("propagates a malformed verdict as a VerifyHarnessError", async () => {
    await expect(
      runAutoVerify(descriptor, {
        produceVerdict: () => ({ verdict: "LGTM", mustFix: [], notes: "" }),
      }),
    ).rejects.toThrow(VerifyHarnessError);
  });
});
