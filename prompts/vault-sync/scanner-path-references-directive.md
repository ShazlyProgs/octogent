# Scanner directive: scan-path-references

Read `_scanner-base.md` first.

## Your ID
`path-references`

## Scope
All docs under `$VAULT/**/*.md` and `$OCTOGENT/**/*.md`. Exclude: `$COWORK/Emails/**`, `$STATE/_archive/**`, `node_modules`, `.git`, `$VAULT/.trash/**`, this run's output dir.

## Ground truth
Filesystem. Every `$SYMBOL/some/path` or bare absolute path mentioned in a doc should resolve to a real file or directory.

Resolve `$SYMBOL` via `$OCTOGENT/REPOS.md` § Symbol Table.

## What to check

1. **Symbolic paths**: match `\$[A-Z_]+(?:/[^\s\`\"'<>\)]+)?` — resolve `$SYMBOL`, then check filesystem.
2. **Absolute Windows paths**: `C:/Users/mohamed.elshazly/...` or `C:\\Users\\mohamed.elshazly\\...` — flag if the path doesn't exist.
3. **Absolute POSIX paths**: `/c/Users/...` style — same.

## What to flag

For each broken path:
- `severity`: tier-1 if the fix is mechanical (clear which symbol it should use); tier-2 if the correct replacement is ambiguous
- `finding`: "Broken path reference `<path>` in `<file>:<line>`"
- `expected`: the resolved-and-existing canonical path, or the correct symbol
- `actual`: the literal string in the doc
- `proposed_fix`: if tier-1, the concrete replacement; if tier-2, null and note ambiguity in `finding`
- `evidence`: `file:line` + output of filesystem check

## What NOT to flag
- Code fences that are illustrative/pseudo-path examples (marked with "e.g." or explicit "example:" preceding)
- Paths inside template files meant as placeholders (`<tentacleContextPath>` etc.)
- `$SYMBOL` bare mentions without a path suffix (those are valid symbol references)
- URL paths (`https://...`)
- Environment variable placeholders (`${VAR}` inside env.example files)

## Tools
- `Grep` multiline=false for `\$[A-Z_]+/[^\s\`\"'<>\)]+`
- Resolve each hit, then check existence with `Glob` or `Read`

## Output
`findings-path-references.json`

Signal DONE when complete.
