# Scanner directive: scan-roadmap-delivery

Read `_scanner-base.md` first.

## Your ID
`roadmap-delivery`

## Scope
- `$VAULT/ROADMAP.md` (primary — v4 unified roadmap)
- `$ORCHESTRATION/docs/ROADMAP.md` (if it exists)

## Ground truth
**Parser-authoritative over git-log** (see v1.1 rules below). When `$ORCHESTRATION/docs/ROADMAP.md` is present, its status markers (✅ shipped · ⏳ in-progress · 📋 planned · 🔒 deferred · 🟡 partial) are the authoritative source of truth for phase-level delivery status. Git commit `feat(<phase-id>):` / `docs(<phase-id>):` tags are *supporting evidence*, not a substitute.

Tier 0 items often don't have phase IDs; match by keyword.

## v1.1 rules (baked 2026-04-20 from VAULT-SYNC-PLAN.md § Scanner-specific rules)

These three rules govern every finding this scanner emits. Baked here so the scanner does not need to re-read VAULT-SYNC-PLAN.md at runtime.

### Rule 1 · Parser-authoritative over git-log

When orch ROADMAP (parser-authoritative status markers ✅/⏳/📋/🔒) conflicts with git commit phase IDs, **orch ROADMAP is authoritative**. Commits may be foundation/wiring, not a user-visible feature.

- orch says `📋` + commits exist with matching phase ID → flag as "foundation shipped, user-feature pending" (Tier-2 review). **Do NOT flip unified ROADMAP to ✅ based on commits alone.**
- Worked example: Phase 60 voice streaming marked `📋` in orch ROADMAP despite `380be9fd` + `ab133d97` (B.1-B.5) commits — those commits are pipeline wiring, not the user-visible feature. Vault ROADMAP must mirror orch `📋`.

### Rule 2 · Bidirectional check

The scanner must check BOTH directions, not just "open-but-shipped":

1. **Open-but-shipped**: unified ROADMAP says `open` / `📋` + commits exist → stale-open (Tier-2 flip proposal)
2. **Claimed-open-but-actually-mostly-shipped**: unified ROADMAP claims "N hours open" but orch ROADMAP shows most sub-phases `✅` → overstated openness (Tier-2 correction). Worked example: v4.1 said "Tier 2.1 DB Mgmt 30h open" but Phase 62 is 3/5 `✅` shipped — actual remaining is ~10h.

### Rule 3 · Citation mandatory

Every status flip or correction proposed MUST cite BOTH of:
- (a) commit SHA (for evidence of delivery/partial-delivery), AND
- (b) orch ROADMAP phase row (for parser-authoritative status)

A finding missing either citation is rejected by the synthesizer. No exceptions.

## What to check

1. For each roadmap row with status `open` / `📋` / `backlog`:
   - Extract ID (e.g., `0.A`, `59.4`, `V2`)
   - Cross-reference orch ROADMAP (if present) for that ID's parser-authoritative status
   - Search `git log --oneline` for commits mentioning that ID
   - Apply Rule 1 (parser wins) before flagging

2. For each roadmap row with status `done` / `✅`:
   - Confirm at least one commit referencing it exists (detect lying-about-done edge case)
   - Confirm orch ROADMAP agrees (if present)

3. For each "N hours remaining" / "N hours open" claim:
   - Apply Rule 2 bidirectional check against orch sub-phase statuses
   - If claim overstates openness vs. parser statuses → flag Tier-2 correction

4. For every finding produced: verify it carries Rule 3 citations (commit SHA + orch row). If not, do not emit.

## Running git log safely

From `$REPOS`:
```bash
cd $REPOS
git log --oneline --all -200 | grep -iE '(\bphase\b|\b0\.[A-Z]\b|\b59\.[0-9]+\b|\bV[1-6]\b)'
```

**DO NOT** run `git push`, `git commit`, `git reset`, or anything modifying. Read-only.

## What to flag

- `severity`: tier-2 (semantic — human needs to confirm delivery meaning)
- `finding`: "Roadmap item `<ID>` marked `<state>` but <parser-evidence | commit-evidence> suggests <different-state>"
- `expected`: parser-authoritative state from orch ROADMAP, OR corrected hours-remaining figure
- `actual`: state/claim as written in unified ROADMAP
- `proposed_fix`: null (Tier-2 needs human)
- `evidence`: **both** commit SHA(s) + subject **and** orch ROADMAP phase row (`file:line`). Rule 3 — no one-sided evidence accepted.

## What NOT to flag
- Items where commits mention the ID only in planning context ("adds <ID> to roadmap")
- Items where commits are WIP / draft / revert

## Output
`findings-roadmap-delivery.json`
