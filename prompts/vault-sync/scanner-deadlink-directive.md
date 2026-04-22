# Scanner directive: scan-deadlink

Read `_scanner-base.md` first.

## Your ID
`deadlink`

## Scope
- `$VAULT/**/*.md` (exclude `$COWORK/Emails/**`, `$STATE/_archive/**`, `$VAULT/.trash/**`, this run's output dir)
- `$OCTOGENT/**/*.md`

## Ground truth
Filesystem. Internal markdown links and Obsidian wikilinks must resolve:
- `[text](relative/path.md)` — check the relative file exists
- `[[WikiLink]]` — check a file matching `<name>.md` exists somewhere in vault (Obsidian global namespace)
- `[[WikiLink#heading]]` — check the heading exists in the target file

## What to check

1. Extract all `[text](path)` links — skip if path starts with `http`, `https`, `mailto:`, or is an image (`.png`, `.jpg`, etc.)
2. Extract all `[[...]]` wikilinks
3. For each, check existence

## What to flag

- `severity`: tier-1 if the near-miss rewrite is obvious (typo, case mismatch, known rename); tier-2 otherwise
- `finding`: "Broken link: `<link target>` from `<source file>:<line>`"
- `expected`: correct target path or canonical near-match filename
- `actual`: the broken link
- `proposed_fix`: near-match replacement if available, else null
- `evidence`: `file:line`

## What NOT to flag
- External URLs (http/https/mailto)
- Image refs (non-markdown assets)
- Code-block content (inside ``` fences)
- Links with obvious "TODO" / "placeholder" / "example.com" markers

## Output
`findings-deadlink.json`

## Resource budget
Scanning the whole vault for links could be expensive. Use `Grep` with line-level output and batch filesystem checks. If the scan would exceed 5 minutes, report BLOCKED with "needs narrower scope".
