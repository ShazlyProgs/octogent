# REPOS.md — Path Abstraction for the Vault

> **Purpose.** Every Octogent tentacle, prompt, and PLAYBOOK recipe resolves repo and vault paths through **symbolic names defined in this file**, never through hard-coded absolute paths. When Mohamed renames a folder, the change lands here once — no tentacle context rewrite required.
>
> **Rule.** `shazly` and every worker tentacle MUST read this file at boot and resolve symbols before any file operation.
>
> **Last updated.** 2026-04-19

---

## Symbol Table

| Symbol | Current absolute path | Intended rename (if any) | Stability | Notes |
|---|---|---|---|---|
| `$VAULT` | `C:\Users\shazl\Obsidian Vault` | — | stable | Obsidian vault root; Mohamed's central hub. (Migrated 2026-05-29 from `C:\Users\mohamed.elshazly\Obsidian Vault`; resolve from `$env:USERPROFILE` on operator's machine, not from this row's literal — multi-collaborator era.) |
| `$REPOS` | `$VAULT\VS Code Repos` | — | stable | Git mono-repo root; hosts `.git`, all dev projects, `.octogent/` |
| `$RAG` | `$REPOS\CollegaRAG` | — | stable | Python 3.11+ knowledge base. No CLAUDE.md by design. (Renamed from `Collega` — confirmed 2026-04-19.) |
| `$AGENTS` | `$REPOS\Agents\CollegaAgents_CollegaOrchestration` | possible split — see PLAYBOOK § Architectural Decision Tree | **co-located with $ORCHESTRATION** | 24 agent personas in `agents/` |
| `$ORCHESTRATION` | `$REPOS\Agents\CollegaAgents_CollegaOrchestration` | possible split — see PLAYBOOK § Architectural Decision Tree | **co-located with $AGENTS** | Hono + SQLite + React 19 multi-tenant engine |
| `$OCTOGENT` | `$REPOS\Agents\octogent` | — | stable | This tool. Dashboard at `http://127.0.0.1:8787`. |
| `$STATE` | `$REPOS\.octogent` | — | stable | Octogent runtime state: `project.json`, `tentacles/<id>/`, `worktrees/<id>/`, `state/tentacles.json` (created on first persist) |
| `$MEMORY` | `C:\Users\shazl\.claude\projects\C--Users-shazl-Obsidian-Vault\memory` | — | stable | Auto-memory: `MEMORY.md` index + per-topic `.md` files. **Per-machine**; each collaborator's path resolves under their own `$env:USERPROFILE\.claude\projects\<vault-slug>\memory` (vault-slug = vault path with `: \ / ' '` → `-`). |
| `$COWORK` | `$VAULT\Claude Cowork` | — | stable | Emails (read-only), Sessions, Briefings, Calls |
| `$TASKS` | `$VAULT\TASKS.md` | — | stable | Master task tracker — SSOT for work items |
| `$PLANS` | `C:\Users\shazl\.claude\plans` | — | stable | Persistent plan files survive compaction. Per-machine; each collaborator's path is `$env:USERPROFILE\.claude\plans`. |
| `$KNOWLEDGE` | `$VAULT\30-Knowledge` | — | stable | Cross-cutting reference notes (briefings by project code) |
| `$FARID_DEV` | `$REPOS\Farid Dev` | — | stable | Farid R&D projects (AttentionAssist, DataCollectionKit) |
| `$HOBBY` | `$REPOS\Hobby` | — | stable | Personal/open-source projects (pixel-agents, pst-to-obsidian) |
| `$PERSONAL` | `$REPOS\Personal` | — | stable | Non-engineering (Fresh Start, work-briefing, VlmPoC) |

### Resolution rule

When a prompt or CONTEXT.md references `$SYMBOL`, expand it using this table.
When a coordinator or worker writes a new prompt or CONTEXT.md, use `$SYMBOL` — never paste the absolute path.

---

## Usage examples

```
Read $ORCHESTRATION/CLAUDE.md
Grep -r "foo" $AGENTS/agents/
Edit $RAG/app.py
Append to $MEMORY/project_website_hosting.md
```

In a tentacle CONTEXT.md:

```
## Primary repo
$ORCHESTRATION

## Files in scope
$ORCHESTRATION/server/call-handler/**
$ORCHESTRATION/agents/call-receptionist.md
```

---

## Rename procedure

> Use this checklist whenever Mohamed decides to rename or split a repo. Designed as a **30-min mechanical operation** — slot it into any quiet window.

**Pre-flight**
1. Confirm with Mohamed: the new name and whether subsequent repo split is a separate follow-up.
2. Verify no tentacle is mid-execution on the repo being renamed. If any worker is live with uncommitted changes:
   - Ask the worker (`octogent channel send <id> "STATUS?" --from shazly`) to commit-WIP + pause.
   - Wait for DONE-WIP confirmation before proceeding.

**Step 1 — Git move** (in the parent directory, never from vault root)
```bash
cd "$REPOS"
git mv "Collega" "CollegaRAG"           # example for $RAG rename
git commit -m "rename: Collega → CollegaRAG (REPOS.md $RAG)"
```
> **Never** run `git` from vault root. Always from `$REPOS` or deeper.

**Step 2 — Update this file**
Swap the **Current absolute path** column for the affected symbol. Clear the **Intended rename** column. Commit:
```bash
cd "$OCTOGENT"
git add REPOS.md
git commit -m "repos: resolve rename for $RAG"
```

**Step 3 — Sweep tentacle CONTEXT.md files**
Search `$STATE/tentacles/*/CONTEXT.md` (and `todo.md`) for stale path fragments:
```bash
grep -rln "Collega/" "$REPOS/.octogent/tentacles/" 2>/dev/null
```
Any hit that is a hard-coded absolute path (not a `$SYMBOL` reference) must be rewritten to use the symbol. If the tentacle already uses `$RAG`, nothing to change — that is the whole point of the abstraction.

**Step 4 — Sweep PLAYBOOK recipes and prompts**
```bash
grep -rln "Collega/" "$OCTOGENT/"
```
Same rule: hard-coded paths get rewritten to symbols.

**Step 5 — Sweep scheduled tasks, hooks, CI**
```bash
grep -rln "Collega/" "$ORCHESTRATION/scripts/" "$ORCHESTRATION/.github/" "$ORCHESTRATION/db/seed.ts"
```
Update any path that is not a symbol.

**Step 6 — Verify build**
```bash
cd "$ORCHESTRATION" && npm run lint && cd server && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit
```
If a build step broke, the rename touched code — not just paths. Fix and recommit.

**Step 7 — Announce to live tentacles**
For any tentacle that was paused in Pre-flight:
```bash
node bin/octogent channel send <tentacleTerminalId> "REPOS.md updated: $RAG now resolves to CollegaRAG. Resume work." --from <shazly-terminal>
```

## Branch handling during rename

Workers commit to `octogent/terminal-N` branches (Octogent auto-creates). The rename happens on `main`. When a worker next rebases or merges from main, the rename arrives as a regular commit — worktrees move with `git` automatically.

**If a worker has active uncommitted changes when rename lands**:
1. Worker commits WIP on its branch
2. Coordinator runs the rename on main
3. Worker's next `git pull --rebase origin main` resolves the rename without conflict (git is content-aware)
4. If the rename collides with an in-flight file edit, resolve manually; do not `git reset --hard`

## Split procedure (when Option 2/3/4 fires)

Splitting `$AGENTS` and `$ORCHESTRATION` into separate repos is a superset of the rename procedure:
1. Run rename procedure to clean paths first
2. Follow the option-specific steps in PLAYBOOK § Architectural Decision Tree
3. Update symbol table so `$AGENTS` and `$ORCHESTRATION` resolve to different paths

Do **not** attempt a split without Mohamed's explicit go — see PLAYBOOK forcing functions.

---

## When to read this file

- **Every shazly session**, at boot (Step 2 of the startup ritual in `shazly-init.md`)
- **Every worker tentacle**, at boot (Step 1 of the startup ritual in `tentacle-spawn.md`)
- **Before any rename or split proposal** — this file is the authority

When in doubt about a path, check REPOS.md. When REPOS.md is silent, ask Mohamed; don't guess.
