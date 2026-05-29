# Octogent PLAYBOOK — Eternal Recipe Book

> **What this is.** The operational manual for the Collega AI vault's Octogent deployment. Every recipe here is generic; domain-specific playbooks live inside each tentacle's `CONTEXT.md`.
>
> **Who reads this.** `ShazlyAgent` at every boot (Step 2 of its startup ritual, via `.shazly/MANIFEST.md`). `Shazly` glances at this for framework-integrity concerns. Any human or worker that needs to understand how the vault maps to Octogent terminals. Re-read whenever this file changes.
>
> **Last updated.** 2026-04-19 (Session 58) · Supersedes `TENTACLE-PLAYBOOK.md` (archived as `TENTACLE-PLAYBOOK-LEGACY.md`).

## 0. The agent hierarchy (Session 59+)

```
ShazlyAgent  ← center of Octogent canvas (__octoboss__ position); general-purpose summoner
│
├── VaultAgent  ← first tentacle, always live; vault specialist (FULL context parity)
│   ├── Website tentacle        ← vault-domain sub-tentacles (VaultAgent's children)
│   ├── Twilio tentacle
│   ├── Product-dev tentacle
│   ├── Hobby tentacle
│   └── [any future vault domain]
│
└── [ad-hoc purpose-built agents]  ← ShazlyAgent summons for non-vault work
                                       (peer to VaultAgent, not under it)
```

**ShazlyAgent** sits at the `__octoboss__` position — the octopus body itself, not a tentacle. Spawned with NO `--tentacle-id` flag (Octogent assigns `__octoboss__` as fallback, which is the reserved center position). ShazlyAgent is the general-purpose summoner: constitution-aware (rules, hooks, temporal bounds, skills), framework-aware (PLAYBOOK, REPOS), but NOT deep-vault-aware. It routes vault work to VaultAgent and summons ad-hoc agents for everything else.

**VaultAgent** is ShazlyAgent's first tentacle (tentacleId `vaultagent`). It runs the FULL 6-step boot ritual — every memory file, every CLAUDE.md, every hub doc — **achieving context parity with a fresh Claude Code session in the vault root**. VaultAgent handles all vault activities end-to-end. It spawns vault-domain sub-tentacles beneath itself.

**Vault-domain sub-tentacles** are children of VaultAgent (not ShazlyAgent directly). Spawn them with `--parent-terminal-id=<VaultAgent's terminal id>`.

**Ad-hoc purpose-built agents** are children of ShazlyAgent, peer to VaultAgent. Used for one-off research, experiments, non-vault specialized tasks. Short-lived unless the purpose recurs.

**No separate coordinator entity.** The old "Octoboss" role is fully absorbed into ShazlyAgent's framework-supervisor responsibilities (terminal count, merges, shutdown). Octogent's built-in `tentacle-*` templates (`tentacle-reorganize-todos`, `tentacle-planner`, `tentacle-update-tentacle`, `tentacle-context-init`) remain available and can be invoked by ShazlyAgent as subroutines.

All references below to "the coordinator" or "the spawning agent" mean whichever agent holds the parent-terminal-id in the command. For vault-domain work, that's VaultAgent. For ad-hoc non-vault work, that's ShazlyAgent.

---

## 1. Overview — how Octogent maps to the vault

| Concept | Meaning in this vault |
|---|---|
| **Vault** | Mohamed's Obsidian Vault at `$VAULT` (see `REPOS.md`). Contains code, knowledge, emails, tasks, memory. |
| **Tentacle** | A single **domain of work** (e.g. "website finalization", "phone-call tool", "hobby pixel-agents"). One tentacle = one folder at `$STATE/tentacles/<id>/` with `CONTEXT.md` + `todo.md`. |
| **Terminal** | A live Claude Code session attached to a tentacle. Spawned by Octogent via `terminal create`. Gets `OCTOGENT_SESSION_ID` + `OCTOGENT_API_PORT` env vars. |
| **Worker** | A terminal executing on one tentacle's backlog. Uses prompt template `tentacle-spawn`. |
| **ShazlyAgent** | Central terminal at `__octoboss__` position (no tentacle-id). Prompt `shazly-agent-init`. Shared workspace. General-purpose summoner + framework supervisor. Routes vault work to VaultAgent. |
| **VaultAgent** | First tentacle terminal (tentacleId `vaultagent`), child of ShazlyAgent. Prompt `vault-agent-init`. Shared workspace. Full vault-context parity. Spawns vault-domain sub-tentacles. |
| **Channel** | Short-lived messaging path between two terminals. In-memory only — doesn't persist across Octogent restarts. |
| **Worktree** | Octogent-provisioned git worktree at `$STATE/worktrees/terminal-N/` on branch `octogent/terminal-N`. Only for `--workspace-mode worktree` terminals. |
| **Session** | All active terminals between one `start-octogent.bat` launch and its shutdown. |

The vault has **three products** (per `$MEMORY/reference_product_taxonomy.md`): **CollegaRAG**, **CollegaAgents**, **CollegaOrchestration**. The repos do not yet match the product names one-for-one — see § Architectural Decision Tree.

## 2. Path abstraction — `REPOS.md`

Every tentacle, prompt, and recipe here refers to repos by **symbolic names**: `$VAULT`, `$REPOS`, `$RAG`, `$AGENTS`, `$ORCHESTRATION`, `$OCTOGENT`, `$STATE`, `$MEMORY`, `$COWORK`, `$TASKS`, `$PLANS`, `$KNOWLEDGE`, `$FARID_DEV`, `$HOBBY`, `$PERSONAL`.

Resolution: `$OCTOGENT/REPOS.md` § Symbol Table.

**Never hard-code an absolute path** in a CONTEXT.md, prompt, or recipe. If you need a path not in the symbol table, propose an addition to REPOS.md first.

Rename = one REPOS.md edit + a sweep of hits that failed the abstraction. See REPOS.md § Rename procedure.

## 3. Conventions (non-negotiable)

- **One domain per tentacle.** Two domains that keep editing the same file → they are the same domain; merge tentacles.
- **No cross-tentacle file edits.** If two tentacles need the same file, one pauses while the other resolves.
- **Commit per logical unit** on `octogent/<terminalId>`. No bundling.
- **Never `git push`.** Currently 233+ commits held on main. Push only on Mohamed's explicit per-session green light.
- **Never `git` from `$VAULT` root** (reserved for development terminals). Always from `$REPOS` or deeper.
- **Validation-period rule:** Claude Code writes directly only to `$ORCHESTRATION` itself (the orchestrator). All other code work delegates through the CollegaAgents API.
- **One question at a time** when asking Mohamed. Batched questions are a documented anti-pattern for this user (`$MEMORY/feedback_one_question_at_a_time.md`).
- **9-child cap per parent** (`MAX_CHILDREN_PER_PARENT` in Octogent runtime). Batch if more.
- **Never touch another live tentacle's files.** Supervise via channel only.
- **Never modify these surface files** without Mohamed's sign-off: `$OCTOGENT/REPOS.md`, `$OCTOGENT/PLAYBOOK.md`, `$OCTOGENT/prompts/shazly-agent-init.md`, `$OCTOGENT/prompts/vault-agent-init.md`, `$OCTOGENT/prompts/vault-subagent-init.md`, `$OCTOGENT/prompts/vaultsync-agent-init.md`, `$OCTOGENT/prompts/tentacle-spawn.md`, `$OCTOGENT/start-octogent.bat`.

## 4. CLI reference

### Octogent daemon

```
octogent                          # Start dashboard at :8787 in current project
octogent init [project-name]      # Initialize .octogent/ scaffold in cwd
octogent projects                 # List registered projects
```

### Tentacle (folder + metadata)

```
octogent tentacle create <name> --description "..."     # requires daemon running
octogent tentacle list
```

### Terminal (live Claude Code session)

```
octogent terminal create [options]
  --name, -n                   Terminal display name
  --workspace-mode, -w         shared | worktree
  --initial-prompt, -p         Raw initial prompt text (skip if using --prompt-template)
  --terminal-id                Explicit terminal ID (rarely needed; Octogent assigns)
  --tentacle-id                Existing tentacle ID to attach to
  --worktree-id                Explicit worktree ID (rarely needed)
  --parent-terminal-id         Parent terminal ID for child terminals
  --prompt-template            Prompt template name (resolves to $OCTOGENT/prompts/<name>.md)
  --prompt-variables           JSON object of template variables
```

### Channels (inter-terminal messaging)

```
octogent channel send <terminal-id> <message> --from <sender-terminal-id>
octogent channel list <terminal-id>
```

### Octogent auto-injects these template variables (always available)

`{{terminalId}}`, `{{apiPort}}` — filled at spawn time. Custom variables flow through `--prompt-variables`.

### Readiness probe

```
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/terminal-snapshots
# 200 = ready
```

No dedicated `/health` endpoint; `/api/terminal-snapshots` serves as the readiness indicator.

## 5. Hook behavior cheatsheet (from Phase 7 probe, 2026-04-19)

| Condition | Behavior |
|---|---|
| Octogent spawns a terminal with `--workspace-mode shared` and the working directory contains `.claude/settings.json` with hooks | Vault hooks fire normally inside that terminal. `SHAZLY SESSION` SessionStart hook surfaces context-warnings, dirty tree, handoff headline. |
| `--workspace-mode worktree` | Working dir is the isolated worktree at `$STATE/worktrees/<terminalId>/`. If `.claude/settings.json` is not copied into the worktree (it isn't by default), vault hooks **do not fire**. Worker must self-source context via the startup ritual in `tentacle-spawn.md`. |
| Octogent's own HTTP hooks (`/api/hooks/<name>?octogent_session=<id>`) | Fire in both modes. They emit lifecycle events for the dashboard; they do not replace vault hooks. |
| Env vars inside spawned terminal | `OCTOGENT_SESSION_ID=<terminalId>`, `OCTOGENT_API_PORT=8787`, `OCTOGENT_API_ORIGIN=http://127.0.0.1:8787` |
| CollegaAgents hooks at `$ORCHESTRATION/scripts/hooks/` | These are per-project (triggered by `$ORCHESTRATION/.claude/settings.json`) and are independent of Octogent. They fire when a terminal's cwd is inside `$ORCHESTRATION`, regardless of workspace mode. |

**Design consequence.** `shazly` always runs in `shared` mode (so it inherits full vault context via hooks + via its startup ritual). Workers default to `worktree` mode when editing code on a branch, `shared` mode when running a persistent process or doing vault-wide reads.

## 6. Recipes

Each recipe names the steps; **ShazlyAgent** is the actor unless noted (framework-level recipes are Shazly's). `{{terminalId}}` in these commands always means **ShazlyAgent's** terminal id when spawning a domain tentacle — use its own `OCTOGENT_SESSION_ID` env var.

### Recipe: add-a-tentacle

Ask Mohamed these scoping questions **one at a time**. Stop at the first one he can't answer; ask what to do.

1. **Display name** — e.g. "Pixel Agents Hobby". Short, human-friendly.
2. **Tentacle id (folder name)** — kebab-case, e.g. `pixel-agents-hobby`. Defaults to slug of display name.
3. **Domain (one sentence)** — e.g. "Ship the v1.0.3 bugfix release of the VS Code pixel-agents extension."
4. **Primary repo (symbol)** — one from `$OCTOGENT/REPOS.md`, e.g. `$HOBBY`.
5. **Workspace mode** — `shared` or `worktree`. Default `worktree` for code edits; `shared` for persistent processes or vault-wide work.
6. **OWNS** — bullet list of file globs (use `$SYMBOL` prefixes).
7. **DOES NOT OWN** — bullet list, explicitly name other active tentacles' scopes.
8. **Definition of done** — concrete checklist (can always be extended later).
9. **Reference memory** — existing `$MEMORY/project_*.md` files the worker should read; propose creating a new one if none exists.

Then execute:

```bash
# 1. Create the folder by copying the template (template lives OUTSIDE tentacles/ so
#    Octogent doesn't auto-discover it as a live tentacle)
cp -r "$OCTOGENT/templates/tentacle" "$STATE/tentacles/<tentacle-id>"

# 2. Fill CONTEXT.md and todo.md (replace every [FILL: ...] block)
#    — shazly edits both files inline using the scoping answers

# 3. Register the tentacle in Octogent
cd $OCTOGENT
node bin/octogent tentacle create <tentacle-id> --description "<one-line domain>"

# 4. Spawn the worker
node bin/octogent terminal create \
  --name "<Display Name>" \
  --prompt-template tentacle-spawn \
  --prompt-variables '{"tentacleName":"<Display Name>","tentacleContextPath":"<abs path to $STATE/tentacles/<id>>","domain":"<one sentence>","primaryRepo":"$HOBBY","workspaceMode":"worktree","parentTerminalId":"{{terminalId}}"}' \
  --workspace-mode worktree \
  --tentacle-id <tentacle-id> \
  --parent-terminal-id {{terminalId}}
```

Then announce to Mohamed: tentacle-id, terminal-id, domain sentence. Await worker's `READY` signal.

### Recipe: add-a-product

Adding a new Collega AI product (e.g. a future CollegaInsights) is `add-a-tentacle` with a **REPOS.md update first**.

1. Propose the new symbol and path: `$INSIGHTS` → `$REPOS/CollegaInsights` (or whatever Mohamed approves).
2. Update the REPOS.md symbol table. Commit from `$OCTOGENT`.
3. Continue with `add-a-tentacle` using the new symbol.

### Recipe: rename-a-path

Use `$OCTOGENT/REPOS.md § Rename procedure`. The eight steps live there — follow verbatim. Always:
- Pause active tentacles on the affected repo first
- `git mv` from `$REPOS`, not from vault root
- Update REPOS.md before announcing

### Recipe: retire-a-tentacle

When a tentacle's backlog is empty and work is merged:

1. Confirm with Mohamed the tentacle is done.
2. Check transcripts: `curl -s http://127.0.0.1:8787/api/terminal-snapshots` — is the worker still `live`?
3. If `live`, message the worker: `node bin/octogent channel send <id> "RETIRE — finalize any uncommitted work and exit" --from {{terminalId}}`.
4. Wait for `DONE_ALL` or equivalent.
5. Merge the worker's branch to main **only on Mohamed's explicit green light**:
   ```bash
   cd $REPOS
   git checkout main
   git merge octogent/<terminalId> --no-ff -m "merge: <tentacle-id> domain work"
   ```
6. Archive the tentacle folder (move OUTSIDE `$STATE/tentacles/` so Octogent drops it from the dashboard):
   ```bash
   mkdir -p "$STATE/_archive/tentacles"
   mv "$STATE/tentacles/<tentacle-id>" "$STATE/_archive/tentacles/<tentacle-id>-<YYYY-MM-DD>"
   ```
7. Note retirement in `$MEMORY/project_octogent_workflow.md` operational log.

### Recipe: debug-a-tentacle

Symptoms: worker silent > 2 check cycles, or BLOCKED reports vague.

1. `node bin/octogent channel list {{terminalId}}` — read recent messages.
2. Inspect the worktree: `cd "$STATE/worktrees/<terminalId>" && git status && git log --oneline -10`.
3. If the worker is stuck on an env issue or a missing file, gather the specific error and send targeted guidance — not "try again".
4. If the worker is scope-drifting (editing files in DOES NOT OWN), send a hard stop: `STOP EDITING <file> — out of scope. Revert and resume.`
5. If you suspect the worker has deadlocked on a tool call, check the Octogent transcript JSONL at `$STATE/state/transcripts/<terminalId>.jsonl` (created once Octogent persists state).
6. If truly stuck, retire and respawn with a clearer CONTEXT.md.

## 7. Long-running-process convention

Any persistent process — dev server, background worker, file watcher, desktop agent, anything that binds a port or holds a lock — **belongs in its own dedicated `shared`-mode tentacle**.

Reasoning:
- `worktree` mode has its own copy of the workspace; running `npm run dev` inside it would bind ports + sockets from the wrong directory.
- Two worktrees running the same process fight for the same port.
- Running persistent processes alongside edit work means stopping the server every time you edit a file — defeats the purpose.

Naming convention: `svc-<service-name>` — e.g. `svc-orchestration-dev`, `svc-rag-uvicorn`, `svc-pixel-agents-watch`.

## 8. Merge strategy

Workers commit to `octogent/<terminalId>` branches (Octogent auto-creates these). Never push from worker. Merges follow:

1. Worker signals `DONE_ALL`.
2. Shazly reviews the diff:
   ```bash
   cd $REPOS
   git fetch --all
   git log --oneline main..octogent/<terminalId>
   git diff main..octogent/<terminalId>
   ```
3. Shazly reports the diff summary to Mohamed.
4. On explicit green light, merge with `--no-ff` to preserve branch history:
   ```bash
   git checkout main
   git merge octogent/<terminalId> --no-ff -m "merge: <summary>"
   ```
5. **Do not push** unless Mohamed confirms this session's push-go.
6. After merge, retire the tentacle (see Recipe: retire-a-tentacle).

## 9. Validation-period rule (from `$ORCHESTRATION/CLAUDE.md`)

> Claude Code may ONLY write code directly to `$ORCHESTRATION` itself (the orchestrator). ALL other work — CollegaRAG code, Farid projects, persona edits, scoring changes, UI features, roadmap updates — MUST be delegated through the CollegaAgents API to the appropriate agent. If an agent fails, fix the SYSTEM so the agent can succeed, then retry. Never bypass the system as a shortcut.

Shazly applies this rule when deciding whether a domain needs an Octogent worker or a CollegaAgents API delegation. Borderline cases — ask Mohamed.

## 10. Forbidden actions

| Never | Because |
|---|---|
| `git push` without Mohamed's per-session go | 233+ commits held; push is a coordinated release event |
| Rename a folder without the REPOS.md procedure | Breaks every tentacle CONTEXT that hard-coded a path |
| Touch another live tentacle's files | Scope collision → merge conflicts → lost work |
| Pick one of the 4 architectural options | Mohamed decides when a forcing function fires |
| Run `git` from `$VAULT` root | Reserved for development terminals |
| Commit secrets (env files, credentials, tokens) | See `$VAULT/CLAUDE.md` exec safety |
| Edit `$COWORK/Emails/` | Read-only archive |
| Spawn more than 9 children per parent | Runtime hard limit |
| Delete a tentacle folder without archiving | Loses CONTEXT history |

## 11. Architectural Decision Tree — the 4 repo-structure options

Mohamed has not chosen. `shazly` documents state; does not decide.

### Option 1 — Status quo + cosmetic renames

- `$RAG` renamed to `$REPOS/CollegaRAG` (git mv)
- `$AGENTS` and `$ORCHESTRATION` remain co-located in `$REPOS/Agents/CollegaAgents_CollegaOrchestration`
- **Pro:** minimal disruption. Deliverable in 30 min.
- **Con:** agents/orchestration still share a tree — two concerns, one repo, one CI pipeline.
- **Forcing function:** marketing site / product pages need a clean `CollegaRAG` name.

### Option 2 — Three separate repos

- `$REPOS/CollegaRAG`, `$REPOS/CollegaAgents`, `$REPOS/CollegaOrchestration`
- **Pro:** each product has independent release cadence, own CI, own issue tracker.
- **Con:** cross-cutting changes touch three repos. Shared types must be published as an internal package. Requires versioning discipline.
- **Forcing function:** first external tenant subscribes to only one product, or legal/licensing requires separation.

### Option 3 — Mega-monorepo with workspaces

- `$REPOS/collega/` with pnpm workspaces: `packages/rag`, `packages/agents`, `packages/orchestration`, `packages/shared`
- **Pro:** atomic cross-product changes. Single CI. Shared types are trivial.
- **Con:** large blast radius; one bad commit affects all products. Requires monorepo tooling (Turborepo/Nx/pnpm) discipline.
- **Forcing function:** ≥3 shared internal packages emerge, or the team grows past 2 engineers.

### Option 4 — Hybrid: RAG standalone + Agents/Orchestration together

- `$REPOS/CollegaRAG` (separate), `$REPOS/collega-platform/` (Agents + Orchestration as one)
- **Pro:** reflects the runtime reality that Orchestration always loads Agents at boot. RAG is cleanly separable (FastAPI microservice).
- **Con:** still two repos; split later if Agents/Orchestration diverge.
- **Forcing function:** RAG needs to ship as a standalone product SKU; Orchestration/Agents stay coupled at runtime.

**Decision trigger:** when any forcing function fires, `shazly` raises the option to Mohamed and runs `Recipe: add-a-product` or a custom split plan. Until then, Option 1's rename is the only sanctioned repo-structure change.

## 12. Hook behavior cheatsheet — see § 5

(Consolidated above to avoid duplication.)

## 13. Probe Results — Phase 7 verification (2026-04-19)

Confirmed via probe from vault-root Claude Code session:

| Fact | How verified | Value |
|---|---|---|
| Daemon port | `curl http://127.0.0.1:8787/api/terminal-snapshots` | 200 OK returning JSON array |
| `--prompt-template <name>` resolves | Inspection of `$OCTOGENT/prompts/` and `dist/prompts/` | Template name without `.md` extension; loader reads `prompts/<name>.md` |
| `--tentacle-id` auto-binds CONTEXT.md | Existing `swarm-worker.md` references `{{tentacleContextPath}}` filled from tentacle binding | Yes — binding surfaces CONTEXT.md at the path, template references it explicitly |
| Env var injection | `hookProcessor.ts` in `apps/api/src/terminalRuntime/` | `OCTOGENT_SESSION_ID`, `OCTOGENT_API_PORT`, `OCTOGENT_API_ORIGIN` |
| `MAX_CHILDREN_PER_PARENT` | `apps/api/src/terminalRuntime.ts` | 9 |
| `shared` vs `worktree` cwd | Source code inspection | `shared` uses main workspace cwd; `worktree` uses `$STATE/worktrees/<terminalId>/` on branch `octogent/<terminalId>` |
| State directory | Filesystem inspection | `$STATE/project.json`, `$STATE/tentacles/`, `$STATE/worktrees/` present. `$STATE/state/tentacles.json` created on first persist. |
| Existing terminals at probe time | `/api/terminal-snapshots` | terminal-1, terminal-2, terminal-7, terminal-8, terminal-9 — the latter three are legacy paste-prompt tentacles (tentacleId=`__octoboss__`, hasUserPrompt=true), flagged for retire-or-finish on shazly boot |

### Gotchas discovered

- **Dev-mode template loading.** `pnpm dev` likely reads templates from `$OCTOGENT/prompts/` source, not `dist/prompts/`. A production bundle reads from dist. To be safe when deploying new templates during a running Octogent session: **restart Octogent once** after writing a new template, or copy the template to both `$OCTOGENT/prompts/<name>.md` **and** `$OCTOGENT/dist/prompts/<name>.md`.
- **Legacy tentacleId `__octoboss__`.** Terminals 7/8/9 show this ID because they were spawned via paste-prompt (no `--tentacle-id`). The system assigns the fallback ID. New template-based spawns correctly populate `--tentacle-id`.
- **Browser auto-open on first start.** The existing `start-octogent.bat` intentionally does not open the browser on fresh start — Octogent opens it itself. The upgraded bat preserves this.

---

## Appendix A — Files this PLAYBOOK expects to exist

| Path | Purpose | Owned by |
|---|---|---|
| `$OCTOGENT/REPOS.md` | Path abstraction | `shazly` (edits via rename procedure only) |
| `$OCTOGENT/PLAYBOOK.md` | This file | Mohamed + `shazly` |
| `$OCTOGENT/prompts/shazly-agent-init.md` | ShazlyBossAgent (center) boot prompt | `shazly` surface |
| `$OCTOGENT/prompts/vault-agent-init.md` | VaultAgent boot prompt | `shazly` surface |
| `$OCTOGENT/prompts/vault-subagent-init.md` | Scoped vault sub-agent (bucket-driven) | `shazly` surface |
| `$OCTOGENT/prompts/vaultsync-agent-init.md` | VaultSyncAgent audit loop | `shazly` surface |
| `$OCTOGENT/prompts/tentacle-spawn.md` | Generic worker prompt | `shazly` surface |
| `$OCTOGENT/prompts/tentacle-*.md` | Operational subroutines (reorganize, update, planner, context-init) | Octogent upstream + local |
| `$OCTOGENT/prompts/swarm-parent.md`, `swarm-worker.md` | Fan-out coordinator + worker (multi-child parallelism) | Octogent upstream |
| `$OCTOGENT/prompts/swarm-{parent,worker}.md` | Parallel swarm pattern | Octogent upstream |
| `$OCTOGENT/templates/tentacle/{CONTEXT.md,todo.md}` | Skeleton copied per new tentacle. Lives OUTSIDE `$STATE/tentacles/` so Octogent does not discover it as a live tentacle. | `shazly` |
| `$STATE/_archive/tentacles/` | Retired tentacles (outside `$STATE/tentacles/` to stay off the dashboard) | `shazly` |
| `$OCTOGENT/start-octogent.bat` | Double-click launcher with Shazly auto-spawn | Mohamed + `shazly` (edits require sign-off) |
| `$OCTOGENT/scripts/ensure-shazly.ps1` | Helper: poll API ready, idempotent Shazly spawn | `shazly` surface |
| `$MEMORY/project_octogent_workflow.md` | Operational log + evolution notes | `shazly` appends |

## Appendix B — Signal vocabulary (workers → parent)

Workers use these exact tokens; `shazly` parses them:

- `READY` — startup ritual complete, picking first todo
- `DONE <todo> commit=<sha>` — one todo complete
- `DONE_ALL` — backlog empty
- `BLOCKED <what> — tried <a>, <b>; need <c>` — stuck; specific
- `SCOPE QUESTION <file>` — borderline file, pre-edit
- `DEVIATION <what> — propose <change>` — plan is wrong; await instruction
- `NEEDS_HUMAN <what>` — question for Mohamed, relay through parent

## Appendix C — Quick commands (copy-paste for shazly)

```bash
# Current terminal state
curl -s http://127.0.0.1:8787/api/terminal-snapshots | python -m json.tool

# Spawn worker for an arbitrary domain (replace <x>)
cd $OCTOGENT
node bin/octogent terminal create \
  --name "<Display Name>" \
  --prompt-template tentacle-spawn \
  --prompt-variables '{"tentacleName":"<name>","tentacleContextPath":"<abs-path>","domain":"<sentence>","primaryRepo":"$SYMBOL","workspaceMode":"worktree","parentTerminalId":"{{terminalId}}"}' \
  --workspace-mode worktree \
  --tentacle-id <tentacle-id> \
  --parent-terminal-id {{terminalId}}

# Send a message to a worker
node bin/octogent channel send <terminalId> "<message>" --from {{terminalId}}

# Read messages from a worker
node bin/octogent channel list {{terminalId}}
```

---

REMINDER: Nothing in this PLAYBOOK is domain-specific. Today's tentacles (website, phone call, product-dev) are **instances** of the framework, not part of it. Keep it this way — every new domain must fit through the existing recipes without PLAYBOOK edits.
