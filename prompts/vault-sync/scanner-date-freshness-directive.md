# Scanner directive: scan-date-freshness

Read `_scanner-base.md` first.

## Your ID
`date-freshness`

## Scope
- `$MEMORY/**/*.md` (memory files)
- `$VAULT/.shazly/MANIFEST.md`
- `$VAULT/ROADMAP.md`
- `$VAULT/.shazly/VAULT-SYNC-PLAN.md`
- `$ORCHESTRATION/CLAUDE.md` (if path resolves)

## Ground truth
Today is **2026-04-19**. Claims that embed dates ("last tested", "updated", "as of", "last synced", "verified") should not be older than 30 days unless the content itself is historical.

## What to check

1. For each doc, extract any self-claimed date (frontmatter `updated: YYYY-MM-DD`, inline "As of YYYY-MM-DD", "Last tested YYYY-MM-DD").
2. Compute age in days vs 2026-04-19.
3. For claims that are *stateful* (integration health, memory-count snapshot, "latest state"), flag if > 30 days.
4. For claims that are *declarative* history (changelog entries, retro notes), don't flag.

## Memory "Verified Status" check
If `$MEMORY/MEMORY.md` or any memory file has an "integration health" / "Verified Status" table with date columns — report each row older than 30 days.

## What to flag

- `severity`: tier-2 (needs review — might be legitimately old)
- `finding`: "Stale claim in `<file>:<line>` — <claim> dated <YYYY-MM-DD>, now <N> days old"
- `expected`: "Refresh or mark explicitly historical"
- `actual`: "<claim snippet>"
- `proposed_fix`: null (tier-2 requires human review)
- `evidence`: `file:line`

## What NOT to flag
- Changelog entries ("v1 (2026-04-01) — initial")
- Historical session notes (`Session-NN.md`)
- Commit message references
- Dates inside frontmatter for *versioned* docs (where older date = correct version boundary)

## Output
`findings-date-freshness.json`
