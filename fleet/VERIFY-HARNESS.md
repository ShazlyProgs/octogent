# D4 adversarial-verify harness — fleet quality parity (#45 W-ORCH-NATIVE, Phase 2)

> Authority: `$VAULT/40-Plans/Active/2026-06-30-W-ORCH-NATIVE-architecture-decision-doc.md` §8 (ruling **D4**) + `2026-06-30-W-ORCH-NATIVE-build-plan.md` **Phase 2** (quality parity leg). Built 2026-07-04 on branch `feat/45-phase1` (MASTER-LIST r92, milestone 2).

## Why

The retired `:3001` delegation engine scored work products with a bespoke scoring stack (planning/advisory/specialist scorers + an LLM judge). #45 **does not port that** (decision doc §8 [D4]). Instead, quality comes from **adversarial-verify per task**: every fleet work product is audited by a **separate** agent that tries to **refute** the claim, not confirm it. This is the *first cut* of the reusable harness behind that.

## What's here

| Path | What |
|---|---|
| `../packages/core/src/application/verifyHarness.ts` | Pure, dependency-light core: `buildVerifyPrompt(descriptor)` (the refute-by-default audit prompt), `VERIFY_VERDICT_JSON_SCHEMA` + `parseVerifyVerdict(raw)` (the structured verdict schema + validator), and the **auto-run** layer `evaluateVerifyGate(verdict)` (deterministic REJECT-blocks gate) + `runAutoVerify(descriptor, {produceVerdict})` (build prompt → run via injected producer → validate → gate). No I/O; the verdict producer is injected. Tests: `packages/core/tests/verifyHarness.test.ts`. |
| `../apps/api/src/cli.ts` | `octogent verify` — emits the prompt (or `--schema`) for an operator/agent to run. |
| `../apps/api/src/fleetSpawn.ts` | **Auto-run hook in the fleet spawn loop** (`--verify` / `OCTOGENT_FLEET_VERIFY=1`): after `--execute` it audits the completed spawn as a work product (`buildFleetSpawnVerifyDescriptor` → `runFleetSpawnVerify`), records the pass/fail artifact to `<stateDir>/fleet-verify.log.jsonl`, surfaces it to the fleet root, and fails closed on REJECT or producer/validation failure (`FleetVerifyBlockedError`). Tests: `apps/api/tests/fleetSpawnVerify.test.ts`. |
| `../apps/api/src/fleetVerifyRuntime.ts` | **Wired verdict producer**: starts a separate native Claude Code verifier beneath the fleet root, reads its structured final turn, points the verdict record at the full append-only terminal transcript, and posts a compact verdict + trace pointer to the fleet-root channel. |

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

## Auto-run and live verify substrate ([D7] — live 2026-07-21)

The auto-run is a **config-gated hook in the fleet spawn loop**, separable from the gated A5 autonomous proposer:

- `evaluateVerifyGate(verdict, {blockOnFixes?})` — deterministic gate: REJECT always blocks, APPROVE never blocks, APPROVE_WITH_FIXES blocks only under `blockOnFixes`. Pure, no model.
- `runAutoVerify(descriptor, {produceVerdict?, gate?})` — builds the prompt, runs it via the **injected** producer, validates the verdict, applies the gate. With **no** producer it returns `status:"pending"` carrying the prompt — it never fabricates a verdict.
- `runFleetSpawn(... , {verify})` — after `--execute`, audits the spawn (`buildFleetSpawnVerifyDescriptor`), records the artifact via the injected sink, surfaces the verdict to the fleet root, and **throws `FleetVerifyBlockedError` on a blocked gate or verifier failure**. CLI: `pnpm fleet:spawn -- --execute --verify` (or `OCTOGENT_FLEET_VERIFY=1`) → appends `<stateDir>/fleet-verify.log.jsonl`.
- The production CLI wires `createFleetVerdictProducer`: a separate Claude Code verifier terminal returns the verdict, while its complete unsummarized JSONL transcript remains at `<stateDir>/state/transcripts/<verifierTerminalId>.jsonl`. Every production verdict record carries that trace pointer. A compact pass/fail message with the same pointer is queued to the root through `/api/channels/:terminalId/messages`, so a failed work product is not silently accepted.
- Verifier timeouts, runtime errors, and malformed schema output are recorded as failed work products and block the runner. The default timeout is ten minutes; override it with `OCTOGENT_FLEET_VERIFY_TIMEOUT_MS`.

Why this is separable from A5: it is a **deterministic per-work-product gate**, not a self-driving loop. The live substrate performs verify → verdict → durable trace pointer → parent notification. It does not propose or activate changes.

## Autonomous proposer cut-line (still gated)

- **FORK-A5-1 still controls activation** — any future autonomous proposer may generate candidates only from config, manifest, and prompt-template versions, never code. Candidate activation remains human; this lane does not implement a self-optimizer.
- **No autonomous A5 eval/propose/activate cycle** — Phase 6 remains a separate later ruling. The shipped [D7] surface is the real verifier substrate it would consume.
- **No planted-error live proof** — the build-plan Phase-2 verify ("adversarial-verify catches a planted error" in a real end-to-end delegation) is operator-gated on the live fleet. Build-complete ≠ proven-on-box.
