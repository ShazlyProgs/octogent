# Scanner directive: scan-memory-integrity

Read `_scanner-base.md` first.

## Your ID
`memory-integrity`

## Scope
- `$MEMORY/` directory
- `$MEMORY/MEMORY.md` (index file)

Resolve `$MEMORY` via REPOS.md (= `C:/Users/mohamed.elshazly/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/`).

## Ground truth
Filesystem vs. MEMORY.md index. Two-way integrity:
1. Every file listed in MEMORY.md must exist on disk.
2. Every `.md` file in `$MEMORY/` (except MEMORY.md itself) must have an entry in MEMORY.md.

## What to check

1. Parse MEMORY.md — each bullet line `- [Title](file.md) — description` → extract `file.md`
2. List all `.md` files in `$MEMORY/` (non-recursive; only root)
3. Set diff:
   - Listed but missing from disk → **broken link** (tier-1, remove entry or restore file)
   - Present on disk but not listed → **orphan** (tier-2 — maybe forgotten, maybe deliberate — human review)

## What to flag

For broken links:
- `severity`: tier-1
- `finding`: "MEMORY.md entry points to missing file `<name>`"
- `expected`: "File exists or entry removed"
- `actual`: "File absent"
- `proposed_fix`: "Remove MEMORY.md line or restore file"
- `evidence`: `MEMORY.md:<line>` + `ls $MEMORY/<name>` → not found

For orphans:
- `severity`: tier-2
- `finding`: "Memory file `<name>` not indexed in MEMORY.md"
- `expected`: "Indexed or archived"
- `actual`: "Present on disk, unreferenced"
- `proposed_fix`: null
- `evidence`: filename + MEMORY.md grep (empty)

## Output
`findings-memory-integrity.json`
