/**
 * D4 adversarial-verify harness (first cut) — #45 W-ORCH-NATIVE Phase 2 quality-parity leg.
 *
 * The retired :3001 delegation engine scored work products with a bespoke scoring
 * stack. #45 decision doc §8 [D4] replaces that with adversarial-verify per task:
 * every fleet work product is audited by a SEPARATE agent that tries to REFUTE the
 * claim, not confirm it. This module is the reusable, dependency-light core of that
 * step. Given a work-product descriptor + its claimed evidence it produces:
 *   1. buildVerifyPrompt() — the refute-by-default audit PROMPT an operator/agent runs.
 *   2. VERIFY_VERDICT_JSON_SCHEMA + parseVerifyVerdict() — the structured VERDICT
 *      schema + validator, mirroring the wave AUDIT_SCHEMA (verdict / mustFix / notes).
 *
 * It performs no I/O and pulls no dependencies. The CLI wiring (`octogent verify`)
 * lives in apps/api — ports-and-adapters, same split as the back-office tools.
 */

/** The audit verdict values — mirrors the wave AUDIT_SCHEMA verdict set. */
export const AUDIT_VERDICTS = ["APPROVE", "APPROVE_WITH_FIXES", "REJECT"] as const;

export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

/** One claimed piece of supporting evidence for a work product. */
export interface EvidenceItem {
  /** e.g. "test", "file", "command", "commit", "log", "probe". */
  kind: string;
  /** The concrete reference — a path, command, SHA, URL, test name, etc. */
  reference: string;
  /** Optional human note on what this evidence is supposed to prove. */
  detail?: string;
}

/** What the fleet claims it built/did, plus the evidence it offers. */
export interface WorkProductDescriptor {
  /** Short title of the work product. */
  title: string;
  /** The single claim to be refuted-by-default (what it says it does / is). */
  claim: string;
  /** Claimed supporting evidence (may be empty — an empty list is itself suspect). */
  evidence?: EvidenceItem[];
  /** Optional: the fence / what was in-scope, so the auditor can flag scope creep. */
  scope?: string;
  /** Optional extra context for the auditor. */
  context?: string;
}

/** The audit verdict — mirrors the wave AUDIT_SCHEMA (verdict / mustFix / notes). */
export interface VerifyVerdict {
  verdict: AuditVerdict;
  /** Blocking defects that MUST be fixed before APPROVE. Empty ⇒ clean. */
  mustFix: string[];
  /** Free-text auditor notes (what was checked, residual risks). */
  notes: string;
}

export class VerifyHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyHarnessError";
  }
}

/**
 * JSON schema the auditing agent must emit. Advertised verbatim inside the prompt
 * and enforced by parseVerifyVerdict — one source of truth for the verdict shape.
 */
export const VERIFY_VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [...AUDIT_VERDICTS] },
    mustFix: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["verdict", "mustFix", "notes"],
} as const;

/** Type guard: is `value` one of the known audit verdicts? */
export const isAuditVerdict = (value: unknown): value is AuditVerdict =>
  typeof value === "string" && (AUDIT_VERDICTS as readonly string[]).includes(value);

const formatEvidence = (evidence: EvidenceItem[]): string => {
  if (evidence.length === 0) {
    return "  (none offered — treat the claim as UNSUPPORTED and hunt for evidence yourself)";
  }
  return evidence
    .map((e, i) => `  ${i + 1}. [${e.kind}] ${e.reference}${e.detail ? ` — ${e.detail}` : ""}`)
    .join("\n");
};

/**
 * Build the refute-by-default audit prompt for a work product. The prompt instructs
 * a SEPARATE agent to assume the claim is FALSE, enumerate failure modes, verify each
 * evidence item against ground truth, and emit ONLY the VerifyVerdict JSON. Throws
 * VerifyHarnessError when the descriptor lacks a title or claim (nothing to audit).
 */
export function buildVerifyPrompt(descriptor: WorkProductDescriptor): string {
  if (!descriptor?.title?.trim()) {
    throw new VerifyHarnessError("work-product descriptor requires a non-empty title");
  }
  if (!descriptor?.claim?.trim()) {
    throw new VerifyHarnessError("work-product descriptor requires a non-empty claim");
  }
  const evidence = descriptor.evidence ?? [];
  const lines: string[] = [
    "You are an ADVERSARIAL VERIFIER. Your job is to REFUTE the claim below, not to confirm it.",
    "Assume the work product is BROKEN until ground-truth evidence forces you to conclude otherwise.",
    "Do NOT trust the author's summary, comments, or persisted state — verify against the actual code, tests, and command output.",
    "",
    `# Work product\n${descriptor.title.trim()}`,
    "",
    `# Claim (refute by default)\n${descriptor.claim.trim()}`,
  ];
  if (descriptor.scope?.trim()) {
    lines.push(
      "",
      `# In-scope fence\n${descriptor.scope.trim()}\nFlag anything outside this fence as scope creep.`,
    );
  }
  if (descriptor.context?.trim()) {
    lines.push("", `# Context\n${descriptor.context.trim()}`);
  }
  lines.push(
    "",
    `# Claimed evidence\n${formatEvidence(evidence)}`,
    "",
    "# Method (do every step)",
    "1. Restate the claim as a set of concrete, independently checkable assertions.",
    "2. For EACH assertion, enumerate how it could be false (missing case, wrong path, stale claim, unrun test, happy-path only, off-by-one, unhandled error).",
    "3. Verify EACH claimed evidence item against ground truth — re-run it, open the file, re-read the output. Note any that are absent, stale, or do not prove what they claim.",
    "4. Hunt for evidence the author did NOT provide that would refute the claim.",
    "5. Decide: APPROVE only if EVERY assertion is independently verified; APPROVE_WITH_FIXES if the core holds but non-blocking defects remain; REJECT if any load-bearing assertion is unverified or false.",
    "",
    "# Output — emit ONLY this JSON object, nothing else:",
    JSON.stringify(VERIFY_VERDICT_JSON_SCHEMA, null, 2),
    "",
    'Example: {"verdict":"REJECT","mustFix":["<blocking defect>"],"notes":"<what you checked and how>"}',
  );
  return lines.join("\n");
}

/**
 * Validate + normalize a raw verdict (object or JSON string) into a VerifyVerdict.
 * Throws VerifyHarnessError on malformed JSON, a non-object, an unknown verdict value,
 * a non-string-array mustFix, or an APPROVE that still carries mustFix items (that
 * contradiction must be APPROVE_WITH_FIXES or REJECT). `notes` defaults to "" when
 * absent. This is the schema-validation half of the harness.
 */
export function parseVerifyVerdict(raw: unknown): VerifyVerdict {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new VerifyHarnessError("verdict is not valid JSON");
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new VerifyHarnessError("verdict must be a JSON object");
  }
  const rec = obj as Record<string, unknown>;
  if (!isAuditVerdict(rec.verdict)) {
    throw new VerifyHarnessError(`verdict.verdict must be one of ${AUDIT_VERDICTS.join(", ")}`);
  }
  if (!Array.isArray(rec.mustFix) || !rec.mustFix.every((m) => typeof m === "string")) {
    throw new VerifyHarnessError("verdict.mustFix must be an array of strings");
  }
  if (rec.verdict === "APPROVE" && rec.mustFix.length > 0) {
    throw new VerifyHarnessError(
      "verdict APPROVE cannot carry mustFix items — use APPROVE_WITH_FIXES or REJECT",
    );
  }
  const notes = typeof rec.notes === "string" ? rec.notes : "";
  return { verdict: rec.verdict, mustFix: rec.mustFix as string[], notes };
}
