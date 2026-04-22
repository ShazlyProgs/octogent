# Scanner directive: scan-objective-coverage

Read `_scanner-base.md` first.

## Your ID
`objective-coverage`

## Scope
- `$ORCHESTRATION/docs/VISION_2026.md` (source of truth for Engine Objectives I-III + A-H)
- `$ORCHESTRATION/docs/ROADMAP.md` (source of phase statuses via parser-authoritative markers ✅/⏳/📋/🔒/🟡)
- `$VAULT/ROADMAP.md` (Engine Objective Coverage Matrix — the reconciliation artifact)

## Ground truth

Three-file triangulation:

1. **VISION_2026.md** defines the objectives — their identity and intended capability.
2. **orch ROADMAP** maps objectives to concrete Phases and carries parser-authoritative delivery status.
3. **vault ROADMAP** — specifically its "Engine Objective Coverage Matrix" table — is the sufficiency check. Every objective must have a row citing (a) capability, (b) %/status, (c) sub-statuses, (d) shipped detail with commit SHAs, (e) remaining work → Tier mapping.

Coverage is complete ⇔ **every VISION objective** appears in the matrix, **every matrix row** agrees with orch ROADMAP parser status, and **every citation** resolves (commit SHA exists, orch row exists).

## v1.1 rules (baked 2026-04-20 from VAULT-SYNC-PLAN.md § Scanner-specific rules)

### Rule 1 · Read objectives from VISION, not ROADMAP
Extract the objective list from `$ORCHESTRATION/docs/VISION_2026.md` § "Three Overarching Objectives" (I-III) and § "Milestone Objectives" (A-H). Do NOT rely on the matrix itself to enumerate objectives — that would make the scanner self-confirming.

### Rule 2 · Cross-check each objective against three files
For every objective extracted from VISION:
- Does it have a Phase mapping in orch ROADMAP? If no → Tier-2 coverage-gap advisory.
- Does it have a row in the vault ROADMAP Coverage Matrix? If no → Tier-2 matrix-gap advisory.
- Do the status markers agree (orch parser-authoritative vs. matrix %)? If no → Tier-2 reconciliation.

### Rule 3 · Detect unplanned delivery
If commits exist that reference an objective ID / phase ID but no Phase is mapped in orch ROADMAP → Tier-2 retrofit-plan advisory (work done without roadmap entry).

### Rule 4 · Citations required for every row assertion
Every matrix row must cite (a) commit SHA(s) for shipped sub-phases, (b) orch ROADMAP row/line for status source. Missing either → flag Tier-2 citation-gap.

## What to check

1. Parse `VISION_2026.md` § "Three Overarching Objectives" (headers `### I.`, `### II.`, `### III.`) and § "Milestone Objectives" (bold `**A.`, `**B.`, …, `**H.`). Record name + capability text for each.

2. Parse `$ORCHESTRATION/docs/ROADMAP.md` for Phase headers (`^## Phase <N>:`). Record: phase id, title, status marker (✅/⏳/📋/🔒/🟡).

3. Parse `$VAULT/ROADMAP.md` § "Engine Objective Coverage Matrix" (table immediately after that heading). For each row, capture: objective letter/roman, %/status, sub-status, detail (incl. SHAs), Tier mapping.

4. Build cross-reference:
   - `{objective} × {phase(s)} × {matrix row}`
   - Flag missing cells per rules 2–4.

5. For every commit SHA cited in the matrix: run `git cat-file -e <sha>^{commit}` from `$REPOS` to confirm SHA resolves. Missing SHA → Tier-2 broken-citation.

## Running the parse safely

From `$REPOS` (never `$VAULT` root):
```bash
cd $REPOS
# Confirm all SHAs cited in the matrix resolve
grep -oE '\b[0-9a-f]{8}\b' "$VAULT/ROADMAP.md" | sort -u | while read sha; do
  git cat-file -e "${sha}^{commit}" 2>/dev/null || echo "MISSING: $sha"
done
```

**DO NOT** modify any file. This scanner produces findings + coverage-matrix fixpack proposals only.

## What to flag

Three finding shapes:

### Shape A — Objective missing from matrix (coverage gap)
- `severity`: tier-2
- `finding`: "Engine Objective `<ID>` defined in VISION_2026.md but absent from vault ROADMAP Coverage Matrix"
- `expected`: matrix row present
- `actual`: no row
- `proposed_fix`: null (needs human authoring of detail + SHA citations)
- `evidence`: `VISION_2026.md:<line>` (objective definition)

### Shape B — Status mismatch (parser-authoritative reconciliation)
- `severity`: tier-2
- `finding`: "Coverage Matrix row for `<ID>` claims `<%/status>` but orch ROADMAP parser-authoritative status is `<marker>`"
- `expected`: align with orch marker
- `actual`: matrix claim
- `proposed_fix`: null
- `evidence`: **both** orch `ROADMAP.md:<line>` AND any shipped-commit SHA(s) cited in the matrix row

### Shape C — Broken citation
- `severity`: tier-2
- `finding`: "Coverage Matrix row for `<ID>` cites SHA `<8char>` which does not resolve in `$REPOS`"
- `expected`: SHA resolves
- `actual`: `git cat-file -e` returns error
- `proposed_fix`: null (citation needs correction)
- `evidence`: `ROADMAP.md:<line>` + failed git command output

### Shape D — Unplanned delivery
- `severity`: tier-2
- `finding`: "Commits reference objective `<ID>` / phase `<N>` but no orch Phase mapping exists"
- `expected`: retrofit plan or Phase entry
- `actual`: unplanned work
- `proposed_fix`: null
- `evidence`: commit SHA(s) with matching `feat(<id>):` tag

## What NOT to flag

- Differences between VISION's abstract capability text and ROADMAP's concrete phasing (this is expected — VISION is abstract, ROADMAP is plan)
- Percentages within 10% tolerance of the parser-status implied ratio (e.g., `60%` when 3/5 are `✅` = 60%)
- Coverage gaps where the objective is explicitly marked `🔒 deferred` in orch ROADMAP with a deferral reason
- Matrix cells marked `TBD` or `pending research` — these are intentional placeholders, not drift

## Output artefacts

1. `findings-objective-coverage.json` — array per `_scanner-base.md` schema
2. If the matrix itself needs updating (new objective discovered in VISION, or parser status changed), emit a fixpack proposal row:
   ```
   proposal: update-coverage-matrix-row
   target: $VAULT/ROADMAP.md § Engine Objective Coverage Matrix
   old_row: <current row text>
   new_row: <reconciled row text, with citations>
   ```
   These go into `proposals.md` under Tier-2 per the standard apply flow.

## First-run lesson (2026-04-20)

Inaugural execution verified terminal-5's manual Coverage Matrix build: all 11 objectives (I-III + A-H) mapped with Tier + citations, zero gaps, zero parser-disagreements, all 38 cited SHAs resolved. Serves as regression baseline — any future run producing a materially different coverage picture without an intervening VISION/ROADMAP edit is itself a finding (scanner-health advisory in `_scanner-base.md`).
