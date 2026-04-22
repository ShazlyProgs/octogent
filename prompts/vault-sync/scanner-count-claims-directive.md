# Scanner directive: scan-count-claims

Read `_scanner-base.md` first.

## Your ID
`count-claims`

## Scope (targeted — don't scan whole vault)
- `$VAULT/CLAUDE.md`
- `$VAULT/.shazly/MANIFEST.md`
- `$VAULT/.shazly/IDENTITY.md`
- `$VAULT/.shazly/COEXISTENCE.md`
- `$VAULT/MOC - *.md` (Maps of Content)
- `$VAULT/ROADMAP.md` (Status at section + Tier 0/4 rows mentioning commit counts)

## Ground truth
Filesystem. Every numeric claim in the form "N files", "N agents", "N personas", "N ADRs", "N scanners", "N tentacles" etc. must match the current count.

Known areas to verify:
- `.shazly/MANIFEST.md` Priority 3 — "16 files as of ..." (project_*), "7 files" (reference_*), "8 files" (feedback_*), 1 (user_profile)
- `CLAUDE.md` — "24 agents", "~5,246 test functions" (CollegaRAG), etc.
- `IDENTITY.md` — "14 ADRs", "N commits held on main"
- `.shazly/MANIFEST.md` + `.shazly/COEXISTENCE.md` — "N commits unpushed/held" claims (propagate in lock-step — any drift between these three files is itself a finding)
- `ROADMAP.md` — any "Push N commits" or "N commits unpushed" appearing in Tier 0.A / Tier 4.1 rows
- `MOC` files — any "N projects", "N items" claims

### Unpushed-commit-count rule (added 2026-04-20 after 233+→14 drift lesson)

**For any `<N>+ commits unpushed` / `<N>+ commits held on main` / `Push <N> commits` claim in governance docs** (IDENTITY.md, MANIFEST.md, COEXISTENCE.md, ROADMAP.md Tier 0.A/4.1 rows):

- **Authoritative ground truth**: `git rev-list --count @{upstream}..HEAD` run from the repo root (i.e., `$REPOS`, not `$VAULT` — per standing order #2 never run git from `$VAULT` root).
- **Preflight**: run `git fetch origin main` first so the upstream reference is fresh (avoids counting against a stale cached origin/main). Skip the fetch and this becomes a silent stale-count bug.
- **Flag condition**: any claim whose number differs by >0 from actual. No tolerance — commit counts are exact integers.
- **Severity**: tier-1 auto-fixable. Mechanical integer replacement: `<N>` → actual count. Include a `(verified <YYYY-MM-DD>)` marker in the replacement to aid next-run drift detection.
- **Cross-file consistency**: if IDENTITY.md says 14 and MANIFEST.md says 233+, that is itself a finding — all governance docs should converge on the same verified number per audit.
- **Lesson-of-origin**: on 2026-04-20, ROADMAP.md v4.2 (and IDENTITY/MANIFEST/COEXISTENCE since v1) all claimed `235` / `233+` commits unpushed. Actual = `14`. A prior push had occurred but no doc was updated. Without this rule, the drift was undetectable because the number "looked plausible" year-round. This rule makes the check mechanical.

## How to verify counts

| Claim | Check |
|---|---|
| `project_*` files in $MEMORY | `ls $MEMORY/project_*.md | wc -l` |
| `reference_*` files | `ls $MEMORY/reference_*.md | wc -l` |
| `feedback_*` files | `ls $MEMORY/feedback_*.md | wc -l` |
| `user_profile*` files | `ls $MEMORY/user_profile*.md | wc -l` |
| 24 agents | `ls $ORCHESTRATION/agents/*.md | wc -l` (if dir exists) |
| ADR count | `ls $ORCHESTRATION/docs/decisions/ADR-*.md | wc -l` |
| Commits unpushed on main | `cd $REPOS && git fetch origin main && git rev-list --count @{upstream}..HEAD` (READ-ONLY, no writes; fetch first to avoid stale-upstream drift) |
| Scanner catalog rows | count rows in `VAULT-SYNC-PLAN.md § Scanner Module Catalog` table |
| Test functions (CollegaRAG) | DO NOT run — too expensive. Flag as "unverified" only. |

## What to flag

For each numeric claim that disagrees with verification:
- `severity`: tier-1 (mechanical number replacement)
- `finding`: "Count claim `<N>` in <claim context> disagrees with actual <M>"
- `expected`: the real count
- `actual`: the claimed count
- `proposed_fix`: "Update `<N>` to `<M>` in `<file>:<line>`"
- `evidence`: the verification command output

## What NOT to flag
- Claims marked "approx", "~", ">=" where actual is within 10% tolerance
- Historical claims explicitly dated ("As of 2026-03-11: 38 files") — those are snapshots, not live
- Hypothetical examples ("if we had 50 files...")

## Output
`findings-count-claims.json`
