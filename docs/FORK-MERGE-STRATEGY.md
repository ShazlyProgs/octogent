# Fork & Upstream Merge Strategy (OCT-03)

> **Why this exists.** This repo is a **Collega fork** of upstream `octogent`
> (`hesamsheikh/octogent`). As of 2026-07-04 the Collega line diverges heavily from
> `upstream/main`: `git diff --stat upstream/main...HEAD` ≈ **102 files / +7071 / −379**
> (hookProcessor, `vaultRoot`, prompts, the `fleet/` C-suite work, back-office tools).
> Without a documented strategy a future `git pull upstream` conflicts blind. This
> file is the strategy. (Register: MASTER-LIST r94 / TECH-DEBT Area 3 OCT-03.)

## Remotes

- `origin` → the Collega fork (ShazlyProgs). `main` = the Collega line. **Never
  force-push shared branches.**
- `upstream` → `hesamsheikh/octogent`. Pull-only; never push.

Sync upstream refs without merging:

```bash
git fetch upstream
git log --oneline upstream/main -10          # what's new upstream
git diff --stat upstream/main...HEAD         # our divergence surface
```

## Where the Collega customizations live

Knowing the surface makes conflicts predictable. The heavy-customization hotspots
(reground with `git diff upstream/main...HEAD -- <path>` before a merge):

| Area | Nature | Conflict risk on upstream pull |
|------|--------|--------------------------------|
| `prompts/` (`*-init.md`, `tentacle-spawn.md`) | Collega-authored vault/fleet prompts | Low — mostly additive/Collega-owned |
| `fleet/`, `apps/api/src/fleetSpawn.ts` | #45 standing C-suite fleet (new) | Low — new files |
| `apps/api/src/backOfficeClient.ts` + `backoffice` CLI | #45 back-office tools seam (new) | Low — new files |
| `apps/api/src/terminalRuntime/hookProcessor.ts` | Modified upstream behaviour | **High** — edits upstream file |
| `apps/api/src/terminalRuntime/vaultRoot.ts` | Collega vault-root detection | Medium — new file, wired into upstream |
| `apps/api/src/createApiServer/*` (security, requestHandler) | Modified upstream + OCT-01 additive | Medium — additive blocks in upstream files |
| `REPOS.md`, `PLAYBOOK.md`, `AGENTS.md`, `docs/` | Collega docs | Low |

Rule of thumb: **new files (`fleet/`, back-office, most prompts) rarely conflict; the
risk is edited upstream files** (`hookProcessor.ts`, `createApiServer/*`,
`terminalRuntime/*`).

## Merge procedure (bringing upstream in)

Prefer **rebasing the Collega commits onto upstream** on a throwaway branch, so our
commits stay a clean, reviewable stack on top of upstream:

```bash
git fetch upstream
git switch -c merge/upstream-YYYYMMDD main
git rebase upstream/main            # replay our commits onto new upstream
# resolve conflicts file-by-file; for edited upstream files, re-apply the Collega
# block, don't drop the upstream change. Keep OCT-01 auth + hookProcessor edits.
pnpm install --frozen-lockfile
pnpm --filter @octogent/api test    # gate: our tests (incl. apiTokenAuth) stay green
```

Then review the diff vs both bases and fast-forward `main` only after the test gate
is green. If a rebase is too tangled, fall back to a merge commit (`git merge
upstream/main`) but keep the same conflict discipline.

## Isolation guidance (reduce future conflicts)

To keep divergence maintainable over time:

1. **Add, don't edit.** Prefer new files over editing upstream files. New capability
   → new module wired in at one call site, not scattered edits.
2. **Fence unavoidable edits.** When an upstream file must change, keep the Collega
   change in a small, clearly-commented block (e.g. the `// OCT-01:` comments in
   `security.ts` / `requestHandler.ts`) so a rebase can re-apply it mechanically.
3. **Env-gate behaviour changes.** Defaults that match upstream (e.g.
   `OCTOGENT_API_TOKEN` unset = upstream behaviour) shrink the semantic diff and make
   conflicts textual, not behavioural.
4. **Larger follow-up (not done here):** move Collega-only subsystems into a dedicated
   overlay dir / package so the upstream tree stays pristine. Tracked as a future unit;
   this doc + the fencing convention is the interim strategy.

## Checklist before any `git pull upstream`

- [ ] `git fetch upstream` and read `git diff --stat upstream/main...HEAD`.
- [ ] Rebase on a `merge/upstream-*` branch, not directly on `main`.
- [ ] Re-apply (never drop) the fenced Collega blocks in edited upstream files.
- [ ] `pnpm --filter @octogent/api test` green (auth + core suites).
- [ ] Sanity-run `:8787` locally before fast-forwarding `main`.
