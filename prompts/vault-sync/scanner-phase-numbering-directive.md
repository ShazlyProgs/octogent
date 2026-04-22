# Scanner directive: scan-phase-numbering

Read `_scanner-base.md` first.

## Your ID
`phase-numbering`

## Scope
- `$VAULT/ROADMAP.md`
- `$ORCHESTRATION/docs/ROADMAP.md` (if exists)
- Any other ROADMAP.md in $REPOS subdirs

## Ground truth
Each phase ID (e.g., `Phase 56`, `Phase 59.2`, `V2`) must be unique within each roadmap document. Cross-roadmap collisions are flagged if they reference different actual work.

Known collision (per ROADMAP.md Status section): "`Phase 56` name collided: v3 used for Database Management; Session 53 repurposed for Document Intelligence Agent". If still present, flag.

## What to check

1. Parse each ROADMAP for phase IDs (regex `\bPhase\s+\d+(?:\.\d+)?\b`, `\b\d+\.\d+\b` within tables, `\bV[1-6]\b`).
2. Within one doc: each ID should appear once as a *definition* (table row or heading), not as reference only.
3. Cross-doc: same ID referencing different phase names → collision.

## What to flag

- `severity`: tier-2
- `finding`: "Phase ID `<N>` used for two different phases"
- `expected`: "Unique ID or rename one"
- `actual`: "Phase <N>: <name A>" and "Phase <N>: <name B>"
- `proposed_fix`: null
- `evidence`: `file1:line1` and `file2:line2`

## What NOT to flag
- References to a phase ID inside historical changelog ("shipped in Phase 56")
- Decimal sub-phases vs. parent (`59.2` and `59` are not collisions)

## Output
`findings-phase-numbering.json`
