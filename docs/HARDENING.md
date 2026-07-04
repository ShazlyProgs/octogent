# Octogent Hardening / Debt Tracker

> **Purpose.** Octogent (the `:8787` orchestration daemon + dashboard) had no
> debt/hardening tracker of its own — the sibling `CollegaAgents_CollegaOrchestration`
> repo has `docs/HARDENING_ROADMAP.md` + `docs/EVALUATION_ROADMAP.md`, octogent had
> nothing (that gap is **OCT-09** below). This file closes it.
>
> **Authority / source of truth.** The consolidated deploy-gating register lives in
> the vault: `40-Plans/Active/2026-07-03-MASTER-LIST-consolidated.md` rows **93–100**
> (= `30-Knowledge/Codebase-Atlas/06-TECH-DEBT-REGISTER.md` Area 3, OCT-01..09). This
> doc is the in-repo mirror + reground evidence; the register stays canonical. Update
> both when an item lands.
>
> **Reground cadence.** Verdicts below were regrounded against the code on
> **2026-07-04** (branch `feat/oct-hardening`, off `feat/45-phase1 @ 2785d98`). Tips
> drift fast during builds — re-verify `file:line` before trusting any row.

---

## Status at a glance

| ID | Area | Severity | In octogent repo? | Status (2026-07-04) |
|----|------|----------|-------------------|---------------------|
| OCT-01 | :8787 has no auth (spawn-PTY surface) | High (contained-on-loopback) | Yes | **BUILT** — env-gated token auth for mutating endpoints |
| OCT-02 | init prompts not fleet-aware / hard-coded memory path | Med | Yes | **RESOLVED** — fixed in `f6f6188` (on base) |
| OCT-03 | fork divergence from upstream, no merge strategy | Med | Yes | **BUILT** — `docs/FORK-MERGE-STRATEGY.md` |
| OCT-04 | `DEVELOPMENT_STATE.md` stale, `CLAUDE.md` Read-First → stale | Med | **No** (orchestration repo) | OPEN — tracked, out of octogent scope |
| OCT-05 | PTY sessions die on API restart (no persistence/reattach) | Med | Yes | OPEN — design noted, high effort |
| OCT-06 | channel delivery has no ack/retry | Med | Yes | OPEN — design noted |
| OCT-07 | orchestration stub/placeholder subsystems | Low-med | **No** (orchestration repo) | OPEN — tracked, out of octogent scope |
| OCT-08 | orchestration self-declared limitations | Low-med | **No** (orchestration repo) | OPEN — tracked, out of octogent scope |
| OCT-09 | no debt/hardening tracker doc for octogent | Low | Yes | **RESOLVED** — this file |

"In octogent repo?" = whether the code lives in this repo (`Agents/octogent`) or in
the co-located `CollegaAgents_CollegaOrchestration` (`:3001`) repo. OCT-04/07/08
name files under `capabilities/`, `email/resend-adapter.ts`, `voice/outbound-agent-call.ts`,
`docs/DEVELOPMENT_STATE.md` — none of which exist in this repo (regrounded 2026-07-04,
`find` returned nothing under `apps/`). They belong to the orchestration register/repo.

---

## OCT-01 — token auth for the local API  ·  **BUILT**

**Gap.** Any local process (or anything, if `OCTOGENT_ALLOW_REMOTE_ACCESS=1` on a
reachable host) could spawn PTYs running `claude` with full tool/filesystem access.
The API enforced loopback `Host`/`Origin` checks but required **no credential**.
Contained-on-loopback by design, but the spawn/mutation surface had no second factor.

**Reground evidence (pre-fix).** `apps/api/src/createApiServer/requestHandler.ts`
gated only Host/Origin; `apps/api/src/createApiServer/security.ts` had no auth
helper; `apps/api/src/server.ts` read no token env.

**Fix.** Env-gated bearer / API-key middleware:

- `security.ts` — `readApiToken`, `isMutatingMethod`, `extractRequestToken`,
  `isAuthorizedRequest` (constant-time compare via `crypto.timingSafeEqual`).
- `requestHandler.ts` — after the Host/Origin checks, mutating requests
  (`POST`/`PUT`/`PATCH`/`DELETE`) require the token; `401 {"error":"Unauthorized."}`
  on miss/mismatch. `GET`/`HEAD` + `OPTIONS` preflight stay open.
- `types.ts` / `createApiServer.ts` — thread `apiToken`.
- `server.ts` + `cli.ts` — read `OCTOGENT_API_TOKEN`; the CLI adds the header to its
  own mutating fetches so `octogent tentacle/terminal/channel` keep working when set.
- Tests: `apps/api/tests/apiTokenAuth.test.ts` (21 cases — unset-open, set-required,
  wrong-token 401, bearer + X-Api-Key accepted, GET/OPTIONS stay open, DELETE gated).

**Behaviour contract.** `OCTOGENT_API_TOKEN` **unset / empty / whitespace** ⇒
unchanged (loopback-open — what the live fleet uses). **Set** ⇒ token required on
mutating endpoints.

### Activation runbook (Mohamed-gated)

> The live `:8787` daemon and every running tentacle session use the unset
> (loopback-open) mode. **Do not** restart the daemon to activate the token
> mid-session — activation is a deliberate, Mohamed-gated maintenance step.

1. Choose a strong random token (e.g. `openssl rand -hex 32`). Store it in the
   vault secrets registry, never in git.
2. Export `OCTOGENT_API_TOKEN=<token>` in the daemon's environment
   (`start-octogent.bat` / the service env), and in any shell that drives `:8787`
   via `curl` or the `octogent` CLI.
3. Restart the daemon in a maintenance window (no live tentacle mid-flight).
4. Update spawn/curl recipes to send `Authorization: Bearer <token>` (or
   `X-Api-Key: <token>`) on every mutating call — including `Claude Cowork/spawns/*`
   POSTs to `:8787/api/terminals`. The `octogent` CLI picks up the env var itself.
5. Verify: a mutating `curl` **without** the header returns `401`; **with** it returns
   `201`/`200`; a `GET` still returns `200` without a header.

### Residuals (intentionally out of scope this pass)

- **WebSocket upgrade** (`/api/terminals/:id/ws`) is **not** token-gated. Browsers
  cannot set `Authorization` on a WS handshake, so gating it would break the live
  dashboard's terminal view. The WS attack requires an already-spawned terminal
  (spawn is now gated). Follow-up: gate via `Sec-WebSocket-Protocol` or a
  query-param token + a dashboard change. `upgradeHandler.ts` still enforces
  Host/Origin.
- **GET reads stay open** when a token is set (telemetry + `deck/.../files/:filename`
  vault reads). Gating reads would require the dashboard to authenticate every poll.
  Track as a follow-up if read-confidentiality is needed.
- Remote exposure still must **never** be enabled on a reachable host: keep
  `OCTOGENT_ALLOW_REMOTE_ACCESS` unset. The token is defense-in-depth, not a
  substitute for loopback-only.

---

## OCT-02 — fleet-aware / portable init prompts  ·  **RESOLVED (stale)**

Fixed before this pass, on the branch base, in commit `f6f6188`
("docs(octogent): fleet-aware + memory-path-portable init prompts (OCT-02)"):
multi-machine Fleet block added, hard-coded `mohamed.elshazly` memory path replaced
with machine-agnostic `$MEMORY`, ADR grammar + dynamic memory-file count. No further
action; the register row can be stamped RESOLVED-STALE.

---

## OCT-03 — fork divergence + merge strategy  ·  **BUILT**

**Reground evidence.** `HEAD` is 8 commits ahead of `upstream/main`;
`git diff --stat upstream/main...HEAD` = **102 files / +7071 / −379** (heavy Collega
customization: hookProcessor, vaultRoot, prompts, fleet/, back-office tools). No
documented merge strategy existed, so a future `git pull upstream` would conflict blind.

**Fix.** `docs/FORK-MERGE-STRATEGY.md` — documents the customization surface, the
"rebase-our-commits-onto-upstream" merge procedure, the high-conflict hotspots, and
the isolation guidance (keep Collega additions in additive files / clearly-fenced
blocks). Full isolation into an overlay dir is noted as a larger follow-up.

---

## OCT-04 — stale `DEVELOPMENT_STATE.md`  ·  OPEN (out of octogent repo)

Names `CollegaAgents_CollegaOrchestration/docs/DEVELOPMENT_STATE.md` +
`CLAUDE.md` — those live in the **orchestration** repo, not here. Fix there
(regenerate `DEVELOPMENT_STATE.md` or repoint the Read-First anchor). Tracked in the
vault register; not actionable inside `Agents/octogent`.

---

## OCT-05 — PTY sessions die on API restart  ·  OPEN (design noted)

**Reground.** `apps/api/src/terminalRuntime/sessionRuntime.ts` owns PTY lifecycle;
`docs/concepts/runtime-and-api.md` already states "PTY sessions do not survive API
restarts". Real risk for long tentacle runs.

**Why not this pass.** High effort + runtime-behaviour-sensitive; changing PTY
lifecycle risks the live fleet and needs a maintenance window to validate. Not a
safe code-only change to land blind.

**Proposed design.** Detach PTYs from the API process (spawn under a supervisor or
`tmux`/`screen`-style holder, or a detached child that survives the API), persist the
`pid`+pty handle in `state/`, and reattach on API start by re-binding the WS stream to
the surviving pty. Needs a reattach protocol + orphan reaping. Track as its own unit.

---

## OCT-06 — channel delivery has no ack/retry  ·  OPEN (design noted)

**Reground.** `apps/api/src/terminalRuntime/channelMessaging.ts` — "delivered" flips
on inject, not on agent-confirm; if the target agent never goes idle, a queued message
can sit undelivered with no redelivery.

**Why not this pass.** Changing delivery semantics is behaviour-sensitive for the
live messaging path; safer to design + test deliberately than to alter blind.

**Proposed design.** Add an ack step (delivered = target consumed/idled on it, not
inject-time), a redelivery timer for idle targets, and a bounded retry with a
dead-letter surface. Persist pending/acked state so a restart doesn't drop messages.

---

## OCT-07 / OCT-08 — orchestration stubs + self-declared limits  ·  OPEN (out of octogent repo)

Both name subsystems in the **orchestration** repo: `capabilities/embeddings.ts` +
`document-retrieval.ts` (RAG forbidden by ADR-007), `email/resend-adapter.ts`,
`voice/outbound-agent-call.ts`, `paperless-shim.ts`, `slack-socket.ts` (OCT-07);
Thompson Sampling / in-memory rate-limit / FTS5 refresh cadence / untested E2E chain
(OCT-08). Regrounded 2026-07-04: none exist under `Agents/octogent/apps/`. Track in the
orchestration repo's `HARDENING_ROADMAP.md` / `EVALUATION_ROADMAP.md` + the vault
register; not actionable here.

---

## OCT-09 — no debt/hardening tracker for octogent  ·  **RESOLVED**

This file. Seeded from register rows 93–100 + 2026-07-04 reground evidence.
