# Scanner directive: scan-architecture-integrity

**Introduced**: Phase 6 Sustainability Layer per Plan v1.1 §6.4

## Scope

Cross-check code structure against active invariants — detect architectural drift where code violates declared invariants without a logged exception.

Primary invariants checked (initial scope; extensible per new invariants):

- **I-07** Privacy / tenant isolation — every tenant-scoped state table has `agent_instance_id` column AND reads check against it
- **I-10** Memory = projections over `session_events`, not parallel tables — no new tables that duplicate `session_events` functionality (e.g., `delegation_ledger` flagged per D07)
- **I-09** Hub/spoke sync — per-service sync mechanism present
- **I-15** Validation for all — presence of test coverage across tiers (unit / integration / live E2E) — basic presence check, not exhaustive

## Ground truth

- `$ORCHESTRATION/.claude-flow/critical-invariants.md` — 25 invariants, 4 tiers
- `$ORCHESTRATION/docs/decisions/ADR-006.md` (memory isolation — pairs with I-07)
- `$ORCHESTRATION/docs/decisions/ADR-011.md` (Session Event Log — pairs with I-10)
- `$ORCHESTRATION/docs/decisions/ADR-012.md` (Credential Proxy Boundary — pairs with I-07)

## Method

### I-07 check (agent_instance_id presence)
1. Read `$ORCHESTRATION/db/connection.ts` + `db/types.ts` + `db/*.ts` for CREATE TABLE statements
2. Identify tenant-scoped tables (those with `tenant_id` column OR declared as tenant-scoped in code comments)
3. Verify each has `agent_instance_id` column (or justified absence with inline comment)
4. Flag absences

### I-10 check (no parallel tables to session_events)
1. Read CREATE TABLE statements
2. Identify tables whose schema duplicates `session_events` fields (`id`, `timestamp`, `event_type`, `payload`, `agent_id`) — especially tables ending in `_ledger` or `_log`
3. Candidates: `delegation_ledger` (D07 flagged), any `*_events`, `*_log` tables
4. For each candidate: verify there's an authority citation (comment, ADR reference, or Plan §) explaining why NOT a projection
5. Flag unauthorized parallel tables

### I-09 check (hub/spoke sync)
1. For multi-instance services (per ADR or docs): verify sync mechanism referenced in code (e.g., `syncTo*`, `publishEvent`, `replicate*`)
2. Basic grep-level check; deep analysis out of scope

### I-15 check (validation breadth)
1. List `server/__tests__/` files
2. Verify presence of:
   - Unit test files (e.g., `*.test.ts` in isolated-logic modules)
   - Integration test files (e.g., `delegation-e2e.test.ts`, `mcp-integration.test.ts`)
   - Live-E2E documentation (session notes referencing live observation)
3. Flag breadth gaps (e.g., chaos / security / distributed layers absent per Phase 3 D09)

## Output

`$VAULT/Claude Cowork/vault-sync/<RUN_ID>/findings-architecture-integrity.json`

Per finding:
```json
{
  "scanner": "architecture-integrity",
  "file": "<source-file:line | table-name>",
  "line": <integer or null>,
  "severity": "tier-1" | "tier-2",
  "finding": "<I-XX violation description>",
  "expected": "<what invariant requires>",
  "actual": "<what code has>",
  "proposed_fix": "<reference Phase 3 D-row + Plan v1.1 §10.3 if scheduled REFACTOR>",
  "evidence": "<file:line code snippet or grep output>"
}
```

## Signal

`octogent channel send terminal-2 "DONE scanner=architecture-integrity findings=<N> run=<RUN_ID>" --from <your-terminal-id>`

## Non-actions

- Do not modify code to fix violations (that's Phase 3 D-row REFACTOR work; scheduled separately)
- Do not flag historical commits (only current state of code)
- Do not exceed listed invariants (extensibility is future scanner work, not this pass)

## Pairs with

- Phase 3 D06 (Magentic naming), D07 (delegation_ledger parallel table), D08 (conversation_documents agent_instance_id), D09 (validation breadth) — already-identified violations
- F4 scheduled scanning (24h catch window)
