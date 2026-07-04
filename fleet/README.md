# Fleet — standing C-suite skeleton (#45 W-ORCH-NATIVE, Phase 1)

> Authority: `$VAULT/40-Plans/Active/2026-06-30-W-ORCH-NATIVE-architecture-decision-doc.md` §8 (the 10 Mohamed rulings) + `2026-06-30-W-ORCH-NATIVE-build-plan.md` Phase 1. Built 2026-07-04 on branch `feat/45-phase1` (MASTER-LIST r92).

This directory is the **in-repo skeleton** of the octogent-native standing fleet that replaces the legacy `:3001` delegation engine. It contains everything needed to stand the fleet up, but standing it up is an **operator-gated action** — the spawn runner is dry-run by default.

## What's here

| Path | What |
|---|---|
| `fleet.json` | Fleet manifest: org-chart tree of 7 standing roles (CEO root + 6 C-suite children) + the ephemeral-specialist policy. Validated by `@octogent/core` `parseFleetManifest()`. |
| `tentacles/<role>/` | Seed folders (CONTEXT.md + todo.md + memory.md) staged into `$STATE/tentacles/<role>/` at spawn. CONTEXT.md is the canonical persona home going forward (seeded from the legacy `$AGENTS/agents/*.md` personas; decision doc §3). |
| `worktree-claude-settings.json` | **[D5] git-deny parity template** staged into each ephemeral specialist worktree's `.claude/settings.json`. |
| `../prompts/csuite-agent-init.md` | Boot prompt template for the standing roles. |
| `../packages/core/src/application/fleetPlan.ts` | Pure manifest validation + parent-before-child spawn ordering (tests in `packages/core/tests/fleetPlan.test.ts`). |
| `../apps/api/src/fleetSpawn.ts` | The spawn runner (tests in `apps/api/tests/fleetSpawn.test.ts`). |
| `BACKOFFICE-TOOLS.md` | **[Phase 2]** the fleet's `:3001` back-office "tools" seam — curated registry (`packages/core/src/application/backOfficeTools.ts`) + HTTP client (`apps/api/src/backOfficeClient.ts`) + `octogent backoffice` CLI. The fleet consumes CRM + Sara voice as TOOLS; the retiring engine tools are deliberately excluded. |

## Rulings → implementation map (decision doc §8)

| # | Ruling | Where implemented |
|---|---|---|
| D1 | C-suite standing tentacles; specialists ephemeral worktree subagents | `fleet.json` roles (`shared`) + `specialists` policy (`worktree`, ephemeral) |
| D2 | ALL C-suite live 24/7 | Standing roles spawned once by the runner; no auto-retire |
| D3 | Per-tentacle files + shared vault memory dir; SQLite read-only history | Each seed's `memory.md` + CONTEXT § Memory; `$VAULT/.shazly/shared-memory/` read; `shazly.db` read-only |
| D4 | Adversarial-verify per task, no old scoring engine | `csuite-agent-init.md` § Delegation model + CTO/GE CONTEXT recipes |
| D5 | Octogent native worktree mode + verify git-deny parity | **Verified: NO native deny exists** (see below) → `worktree-claude-settings.json` + staging step in the recipes |
| D6 | Independent fleet per machine, vault git ferries | `fleet.json` comment + prompt standing order #6 |
| D8 | Tentacles are native Claude Code sessions | Octogent terminals ARE Claude Code sessions; no `claude-client.ts` in the loop |
| D9/D10 | Chat supersede + briefings retire | Phases 3-4, NOT built here (Phase 1 only) |

## [D5] git-deny parity — verification result (2026-07-04)

**Octogent's native worktree mode has NO hard git deny.** Verified at Phase-1 build time:

- `apps/api/src/terminalRuntime/worktreeManager.ts` — creates/removes worktrees + branches only; no permission scoping.
- `apps/api/src/terminalRuntime/ptyEnvironment.ts` — passes the full parent env; injects no deny config.
- `apps/api/src/terminalRuntime/gitOperations.ts:168` — even exposes an operator-side `pushTentacleWorktree()` (dashboard action, not agent-invoked).
- Protection today is prompt-level only (`tentacle-spawn.md` standing orders + PLAYBOOK §3).

The legacy engine enforced a hard deny via `$ORCHESTRATION/server/permission-scoping.ts` `buildDenyList()`. **Parity closure here:** `worktree-claude-settings.json` carries that deny set — destructive git (push/reset/checkout/merge/rebase/clean/cherry-pick/stash/tag/`branch -D`), destructive filesystem (`rm -rf`/`-r`/`-f`), network egress (`curl`/`wget`), `sudo`, and secret-file reads/writes (`.env*`, `credentials*`, `*_key*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`) — with ONE deliberate delta: `git commit` stays ALLOWED because octogent-native workers commit per logical unit on their own `octogent/<terminalId>` branch (the old engine committed on the worker's behalf). (Octogent adds the `Tool(spec:*)` variant form alongside legacy's `Tool(spec *)` for defense in depth; legacy's tenant-scoped `data/**` denies are N/A here — the fleet's shared workspace is the vault, not a per-tenant data dir.)

**Known limitation (residual):** the settings file can only be staged AFTER the terminal (and its worktree) is created, so there is a small race before the child's first edit. The C-suite recipes mitigate (stage immediately, pause the child if needed). Hard closures — checking a `.claude/settings.json` into the mono-repo root at `$REPOS`, or octogent runtime support for pre-seeding worktree files — are follow-ups outside this repo's Phase-1 fence.

## Standing the fleet up (operator-gated — VaultAgent/Mohamed)

Prereqs: octogent daemon running at `:8787` (`/api/terminal-snapshots` returns 200); this machine's live fleet has capacity (7 new terminals; CEO takes 6 children of the 9-cap).

```bash
# from the octogent repo root
pnpm fleet:spawn                    # DRY-RUN: prints stage/deck/spawn plan, changes nothing
pnpm fleet:spawn -- --execute       # stages seeds -> registers tentacles -> spawns parent-before-child
pnpm fleet:spawn -- --execute --boss-terminal-id <shazly-terminal-id>   # optionally hang the CEO under ShazlyAgent
```

The runner: (1) copies `fleet/tentacles/<id>/` → `$STATE/tentacles/<id>/` (existing folders left untouched), (2) POSTs `/api/deck/tentacles` per role ("already exists" tolerated), (3) POSTs `/api/terminals` in plan order, threading each parent's returned `terminalId` into its children's spawn + prompt variables.

Default `$STATE` = `<repo>/../../.octogent` per REPOS.md; override with `--state-dir`.

**Note (dev-mode template loading, PLAYBOOK §13):** if the daemon was running before `prompts/csuite-agent-init.md` landed, restart octogent once (or copy the template into `dist/prompts/`) so the template resolves.

## Phase-1 verification (after stand-up)

Mohamed prompts the CEO terminal → CEO delegates to one C-suite child via channel → the child runs the specialist spawn recipe (incl. the [D5] staging + a `git push --dry-run` denial probe) → result returns up the tree → CEO summarizes to Mohamed. Each tentacle's `todo.md` carries its leg of this chain.

## What Phase 1 deliberately does NOT do

- No `:3001` code changes (excision is Phase 4; back-office services stay live and untouched).
- No Chat parity (Phase 3), no briefings retirement (Phase 4), no A5 autonomous loop (Phase 6).
- No live spawn was executed at build time — the fleet perturbs the live dashboard fleet and is operator-gated.
