# Scanner directive: scan-secret-leak

Read `_scanner-base.md` first.

## Your ID
`secret-leak`

## Scope
All tracked files in `$VAULT` and `$OCTOGENT` — but focus on docs + config:
- `$VAULT/**/*.md`
- `$VAULT/**/*.json` (except `package-lock.json`, `node_modules`)
- `$OCTOGENT/**/*.md`
- `$MEMORY/**/*.md`

Exclude: `$COWORK/Emails/**` (huge), `node_modules`, `.git`, `$STATE/_archive/**`, `$VAULT/.trash/**`, `dist/`, `build/`.

## Ground truth
Regex patterns for common secret shapes. **Never log a matched secret** — in the finding, show only the masked form (first 6 chars + `…`) + file:line. Mohamed reads the file directly if needed.

## Patterns to check

| Pattern | Regex shape | Severity |
|---|---|---|
| OpenAI key | `sk-[A-Za-z0-9]{20,}` (modern: `sk-proj-[A-Za-z0-9_-]{40,}`) | tier-3 block |
| Anthropic key | `sk-ant-[A-Za-z0-9_-]{80,}` | tier-3 block |
| GitHub token | `ghp_[A-Za-z0-9]{36}`, `gho_`, `ghs_`, `github_pat_[A-Za-z0-9_]{80,}` | tier-3 block |
| AWS access key | `AKIA[0-9A-Z]{16}` | tier-3 block |
| Slack bot token | `xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}` | tier-3 block |
| Generic high-entropy assignment | `(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_/+\-]{20,}['"]` | tier-3 if no placeholder markers |
| Private key | `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----` | tier-3 block |

## What to flag

- `severity`: ALWAYS tier-3 (block — never auto-apply; needs human rotation)
- `finding`: "Possible secret: `<pattern-name>` in `<file>:<line>`"
- `expected`: "Rotate credential and remove from file"
- `actual`: "`<first 6 chars>…`" (NEVER the full secret in the finding)
- `proposed_fix`: null — tier-3 is never auto-applied
- `evidence`: `file:line` only (no body)

## What NOT to flag
- Explicit placeholder markers: `<YOUR_API_KEY>`, `REPLACE_ME`, `xxx...`, `example`, `dummy`, `test-key`, `redacted`
- Inside fenced code blocks marked as examples (preceded by "example:" or in a "Usage" section)
- `.env.example` files where values are obviously template placeholders
- Hash-like strings that are clearly commit SHAs, content hashes, or UUIDs

## Safety rule
If a real secret is found: do NOT write it to the findings JSON body. Show only masked form. Write the finding to the standard output file. Do NOT send the secret over channel messages.

## Output
`findings-secret-leak.json`
