# [FILL: Tentacle display name]

> **Template.** Copy this folder to `$STATE/tentacles/<new-id>/`, rename, fill all `[FILL: ...]` blocks, and delete this quote block before spawning the worker.

---

## Purpose

[FILL: One sentence describing what this tentacle exists to accomplish. Example: "Finalize the Collega AI marketing site (Iubenda + IT/DE translation)."]

## Primary repo

[FILL: Single symbol from `$OCTOGENT/REPOS.md`. Example: `$ORCHESTRATION`]

## Workspace mode

[FILL: `shared` or `worktree`. Rule: `shared` if this tentacle needs to read vault-wide state (CLAUDE.md, MEMORY, TASKS.md) or runs a persistent process. `worktree` if it edits code on its own branch in isolation from other tentacles.]

## Scope — what this tentacle OWNS

[FILL: Bullet list of file globs and memory files this tentacle may edit. Use `$SYMBOL` prefixes. Example:
- `$ORCHESTRATION/server/call-handler/**`
- `$ORCHESTRATION/agents/call-receptionist.md`
- `$MEMORY/project_phone_call_tool.md`
]

## Scope — what this tentacle DOES NOT own

[FILL: Bullet list of paths this tentacle must never edit, even if tempted. Example:
- `$ORCHESTRATION/brand/**` — belongs to the website tentacle
- `$ORCHESTRATION/frontend/**` — belongs to product-dev
- Any `$MEMORY/` file not listed in OWNS above
]

## Exclusion zones (other active tentacles)

[FILL: List of tentacles currently running and their domains. Update when a new tentacle spawns or retires. Copied by shazly from `$STATE/state/tentacles.json` at spawn time.]

## Definition of done

[FILL: Concrete, testable checklist. Example:
- [ ] Iubenda URLs substituted in `brand/website/index.html`
- [ ] Cookie banner JS injected in `<head>`
- [ ] IT/DE language files published
- [ ] Mohamed re-uploaded to /www/ and Iubenda re-scan clears all warnings
]

## Escalation rules — when to message parent

Send to parent (`shazly`) via channel when:
- **BLOCKED** on a dependency outside scope (another tentacle, human input, external service)
- **DONE** with a logical unit, awaiting merge or next instruction
- **SCOPE QUESTION** — about to touch a file and uncertain whether it's in scope
- **CROSS-TENTACLE CONFLICT** — discovered that another tentacle edited a file this one owns

Do not message for routine progress. The parent checks transcripts.

## Commit convention

- Branch: `octogent/<terminalId>` (auto-created by Octogent in `worktree` mode)
- One commit per logical unit. Never bundle unrelated changes.
- Message format: `<scope>: <imperative summary>` — e.g. `voice: add IT locale to CAI config`
- **Never `git push`** — parent merges on Mohamed's explicit green light.
- **Never `git reset --hard`** on shared branches.

## Reference memory

Read these at boot (paths use symbols from `$OCTOGENT/REPOS.md`):
- [FILL: `$MEMORY/project_<domain>.md` — the domain memory file(s) for this tentacle]
- `$OCTOGENT/REPOS.md`
- `$OCTOGENT/PLAYBOOK.md`
- `$ORCHESTRATION/CLAUDE.md` (if touching $AGENTS or $ORCHESTRATION code)

## Session seed (optional)

[FILL: Any one-time context the first worker needs that isn't in memory files — example: current status of an external wizard, a decision Mohamed made verbally, a value from a dashboard.]
