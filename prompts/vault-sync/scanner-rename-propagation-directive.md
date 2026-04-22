# Scanner directive: scan-rename-propagation

Read `$VAULT/Claude Cowork/vault-sync/20260419T191900Z/_scanner-base.md` first for output + signal contract.

## Your ID
`rename-propagation`

## Scope
All vault docs: `$VAULT/**/*.md`, `$OCTOGENT/**/*.md`, tentacle `CONTEXT.md` + `todo.md`. Exclude `$COWORK/Emails/**` (read-only archive), `$STATE/_archive/**`, `node_modules`, `.git`, `$VAULT/.trash/**`, `$VAULT/Claude Cowork/vault-sync/**` (this run's output).

## Ground truth
`$OCTOGENT/REPOS.md` § Symbol Table. The "Intended rename" column lists pending renames. When a row's Intended rename column is EMPTY and the Current path contains a name, any *stale* name of that path in docs is a finding.

Known historical rename events to check:
- `Collega/` → `CollegaRAG/` (confirmed complete in REPOS.md)
- `ShazlyAgents/` → `CollegaAgents_CollegaOrchestration/` (renamed ~Session 47)
- `Farid Knowledge/` → `30-Knowledge/`
- `Octoboss` → `Shazly` / `ShazlyAgent` (Session 59 rename; reserved id `__octoboss__` preserved — do NOT flag that literal token)
- `nifty-crunching-flame.md` (legacy plan) → superseded by `$VAULT/ROADMAP.md` — flag *new* references that imply it's still authoritative, not historical mentions

## What to flag

For each stale name occurrence in a doc:
- `file`: relative to `$VAULT`
- `line`: line number
- `severity`: tier-1 (mechanical rewrite to new name)
- `finding`: "Stale reference to `<old-name>` — renamed to `<new-name>`"
- `expected`: the new name
- `actual`: the line content
- `proposed_fix`: "Replace `<old>` with `<new>` at this line"
- `evidence`: `file:line` + the literal matched string

## What NOT to flag
- Matches inside fenced code blocks that are explicitly historical/changelog entries
- Matches in filenames that are historical records (e.g., `Session-47-rename.md`)
- The reserved id token `__octoboss__` (it's the canonical center position, not stale)
- `Collega AI SRL` (company name; not a path rename)
- `CollegaAgents` when used as the 24-agent system name (valid; only flag if referring to the old directory `$REPOS/Agents/CollegaAgents` as a *repo path*)

## Tools
Use `Grep` with pattern alternations:
- `\bCollega/|\bCollega\\|["'\x60]Collega["'\x60]` (the old repo path, careful — "Collega" is also a brand)
- `ShazlyAgents` (word-boundary)
- `Farid Knowledge`
- `nifty-crunching-flame` (when context suggests active authority, not historical)

Cross-check each hit: is it a path reference or prose? Only path-like references are Tier-1.

## Output
`$VAULT/Claude Cowork/vault-sync/20260419T191900Z/findings-rename-propagation.json`

Signal DONE with file path and count when complete.
