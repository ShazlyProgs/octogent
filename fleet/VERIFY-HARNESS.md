# D4 adversarial-verify harness — fleet quality parity (#45 W-ORCH-NATIVE, Phase 2)

> Authority: `$VAULT/40-Plans/Active/2026-06-30-W-ORCH-NATIVE-architecture-decision-doc.md` §8 (ruling **D4**) + `2026-06-30-W-ORCH-NATIVE-build-plan.md` **Phase 2** (quality parity leg). Built 2026-07-04 on branch `feat/45-phase1` (MASTER-LIST r92, milestone 2).

## Why

The retired `:3001` delegation engine scored work products with a bespoke scoring stack (planning/advisory/specialist scorers + an LLM judge). #45 **does not port that** (decision doc §8 [D4]). Instead, quality comes from **adversarial-verify per task**: every fleet work product is audited by a **separate** agent that tries to **refute** the claim, not confirm it. This is the *first cut* of the reusable harness behind that.

## What's here

| Path | What |
|---|---|
| `../packages/core/src/application/verifyHarness.ts` | Pure, dependency-light core: `buildVerifyPrompt(descriptor)` (the refute-by-default audit prompt), `VERIFY_VERDICT_JSON_SCHEMA` + `parseVerifyVerdict(raw)` (the structured verdict schema + validator), and the **auto-run** layer `evaluateVerifyGate(verdict)` (deterministic REJECT-blocks gate) + `runAutoVerify(descriptor, {produceVerdict})` (build prompt → run via injected producer → validate → gate). No I/O; the verdict producer is injected. Tests: `packages/core/tests/verifyHarness.test.ts`. |
| `../apps/api/src/cli.ts` | `octogent verify` — emits the prompt (or `--schema`) for an operator/agent to run. |
| `../apps/api/src/fleetSpawn.ts` | **Auto-run hook in the fleet spawn loop** (`--verify` / `OCTOGENT_FLEET_VERIFY=1`): after `--execute` it audits the completed spawn as a work product (`buildFleetSpawnVerifyDescriptor` → `runFleetSpawnVerify`), records the artifact to `<stateDir>/fleet-verify.log.jsonl`, and gates on REJECT (`FleetVerifyBlockedError`). Tests: `apps/api/tests/fleetSpawnVerify.test.ts`. |

## The verdict schema (mirrors the wave `AUDIT_SCHEMA`)

```json
{ "verdict": "APPROVE | APPROVE_WITH_FIXES | REJECT", "mustFix": ["<blocking defect>"], "notes": "<what was checked>" }
```

`parseVerifyVerdict` enforces it: unknown verdict → error, non-string-array `mustFix` → error, and an `APPROVE` that still carries `mustFix` items → error (that contradiction must be `APPROVE_WITH_FIXES` or `REJECT`). `notes` defaults to `""` when absent.

## How a tentacle / operator uses it

```bash
# from $OCTOGENT (octogent repo root)
node bin/octogent verify --schema        # print the verdict JSON schema

# emit the refute-by-default audit prompt for a work product:
node bin/octogent verify \
  --title "cfo_report back-office tool" \
  --claim "GET /api/cfo/report returns the finance report behind X-API-Key auth" \
  --scope "read-only endpoint only; no WhatsApp side-effects"

# or pass a full descriptor (with claimed evidence[]):
node bin/octogent verify --descriptor '{"title":"...","claim":"...","evidence":[{"kind":"test","reference":"cfo-route.test.ts"}]}'
```

The emitted prompt is fed to a **separate** auditing agent. It assumes the work product is BROKEN, restates the claim as checkable assertions, enumerates how each could be false, re-verifies every claimed evidence item against ground truth, hunts for missing refuting evidence, and returns ONLY the verdict JSON. The caller validates that JSON with `parseVerifyVerdict`.

## Auto-run (Phase-2 tail — delivered 2026-07-04, r92 p2-tails)

The "next milestone" auto-run is now built as a **config-gated hook in the fleet spawn loop**, separable from the LATER A5 autonomous loop ([D7]):

- `evaluateVerifyGate(verdict, {blockOnFixes?})` — deterministic gate: REJECT always blocks, APPROVE never blocks, APPROVE_WITH_FIXES blocks only under `blockOnFixes`. Pure, no model.
- `runAutoVerify(descriptor, {produceVerdict?, gate?})` — builds the prompt, runs it via the **injected** producer, validates the verdict, applies the gate. With **no** producer it returns `status:"pending"` carrying the prompt — it never fabricates a verdict.
- `runFleetSpawn(... , {verify})` — after `--execute`, audits the spawn (`buildFleetSpawnVerifyDescriptor`), records the artifact via the injected sink, and **throws `FleetVerifyBlockedError` on a blocked gate**. CLI: `pnpm fleet:spawn -- --execute --verify` (or `OCTOGENT_FLEET_VERIFY=1`) → appends `<stateDir>/fleet-verify.log.jsonl`.

Why this is separable from A5: it is a **deterministic per-work-product gate**, not a self-driving loop. The A5-1..4 forks gate the *autonomous* meta-harness (build-plan Phase 6 [D7], "LATER"); this hook needs none of them — the verdict PRODUCER is injected, so wiring an LLM/agent adapter (or the A5 eval suite) is an additive follow-up.

## Cut-line (still deliberately not yet)

- **No wired verdict producer / no A5 eval suite** — the auto-run hook records the audit prompt PENDING when no producer is injected; wiring a live LLM/agent producer (auto-audit every work product with a real model) and the A5 autonomous eval suite is the LATER [D7] milestone.
- **No planted-error live proof** — the build-plan Phase-2 verify ("adversarial-verify catches a planted error" in a real end-to-end delegation) is operator-gated on the live fleet. Build-complete ≠ proven-on-box.
