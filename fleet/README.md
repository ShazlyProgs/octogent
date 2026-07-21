# Fleet canon v2 — Org v2.1

> Authority: Mohamed-direct, 2026-07-21. Org v2.1 ratified; build authorized. The fleet is standing but dormant-by-default. Stand-up, restart, rollout, service mutation, commit, and push remain operator-gated.

This directory is the in-repo contract for the octogent-native fleet. A standing identity has a durable seed, registered terminal record, and parent edge; it does not consume a Claude session while dormant. Wake is explicit and bounded.

## Ratified graph — 22-node context

The executable manifest contains 11 standing roles and five profiles. Six out-of-repo VaultAgent deck-mirror records are shown for organizational context only, bringing the published view to 22 nodes. Representation records are not runner inputs.

```text
fleet-ceo (root; standing)
├─ fleet-cos (standing)
├─ fleet-platform-tl (standing)
│  ├─ fleet-cto (standing)
│  │  ├─ platform-product-engineer (profile; summon on demand)
│  │  └─ platform-operations-engineer (profile; summon on demand)
│  └─ fleet-cpo (standing)
├─ fleet-cfo (standing)
├─ fleet-ciso (standing)
├─ fleet-clo (standing)
├─ fleet-cmo (standing)
│  ├─ growth-operations (profile; summon on demand)
│  └─ sara (bound-service profile; never a Claude session)
├─ fleet-customer-success (standing)
├─ fleet-general-engineer (standing)
│  └─ client-delivery (profile; summon on demand)
└─ vault-agent (representation; out of repo)
   ├─ concierge (representation; out of repo)
   ├─ codex-build (representation; out of repo)
   ├─ data-room (representation; out of repo)
   ├─ platform-ui (representation; out of repo)
   └─ data-collection-kit (representation; out of repo)
```

Parent mapping, stated without shorthand:

| Slug | Parent | Class | Runner behavior |
|---|---|---|---|
| `fleet-ceo` | none | standing role | roles-only plan; persistent identity |
| `fleet-cos` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-platform-tl` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-cfo` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-ciso` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-clo` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-cmo` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-customer-success` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-general-engineer` | `fleet-ceo` | standing role | roles-only plan; dormant-by-default |
| `fleet-cto` | `fleet-platform-tl` | standing role | roles-only plan; dormant-by-default |
| `fleet-cpo` | `fleet-platform-tl` | standing role | roles-only plan; dormant-by-default |
| `platform-product-engineer` | `fleet-cto` | profile | registered dormant record; wake on demand |
| `platform-operations-engineer` | `fleet-cto` | profile | registered dormant record; wake on demand |
| `client-delivery` | `fleet-general-engineer` | profile | registered dormant record; wake on demand |
| `growth-operations` | `fleet-cmo` | profile | registered dormant record; wake on demand |
| `sara` | `fleet-cmo` | bound service | registered representation only; never wake/spawn |
| `vault-agent` | `fleet-ceo` | representation | deck mirror only; never spawned by this runner |
| `concierge` | `vault-agent` | representation | deck mirror only; never spawned by this runner |
| `codex-build` | `vault-agent` | representation | deck mirror only; never spawned by this runner |
| `data-room` | `vault-agent` | representation | deck mirror only; never spawned by this runner |
| `platform-ui` | `vault-agent` | representation | deck mirror only; never spawned by this runner |
| `data-collection-kit` | `vault-agent` | representation | deck mirror only; never spawned by this runner |

`finance-pipeline` is the CFO's inherited operating system, not a manifest/profile node. Its living STATE and August queue are pointers in the CFO seed. Hifini was dropped by Mohamed's ruling. The 17 archived legacy roles and their historical rows are not manifest nodes. The VaultAgent branch remains an external runtime/deck mirror: `fleet/tentacles/vaultagent/` documents the representation, but `vaultagent` is never spawnable by `fleetSpawn.ts`.

## Manifest v2 contract

`fleet.json` version 2 has two identity sections:

- `roles[]`: the 11 standing org-tree roles. `buildFleetSpawnPlan()` remains roles-only and validates the single rooted tree plus the native child cap.
- `profiles[]`: `id`, `name`, owning `parentRoleId`, `promptTemplate`, `seedDir`, and `kind`. A profile parent must be a role. `buildProfileRecords()` produces parent-linked, register-only terminal create requests using a resolved charter as `initialInputDraft`; it never emits `initialPrompt`. `bound-service` metadata prevents wake.

The existing `specialists` policy remains for temporary work-shaped subagents in isolated worktrees. Profiles are durable summon identities; ephemeral specialists are disposable execution units. Neither category restores the archived RAG-era standing roster.

### Engine policy (`agentProvider`, Mohamed-ruled 2026-07-21)

Every role and profile may declare `agentProvider: "claude-code" | "codex"`, carried into the terminal record at spawn/registration and honored on every wake. The ratified default: all 11 standing officers run `claude-code` (judgment work); the 4 summon build profiles default to `codex`; `sara` declares nothing because a bound-service never runs a session (the parser rejects a provider there). GLM remains a delegation lane, never a per-node provider. Flip a node by editing its one manifest line and re-registering.

## Wake lifecycle

Before every wake, read `GET /api/terminal-snapshots`. A registered record with no `agentRuntimeState` is dormant.

```text
POST /api/terminals/<terminalId>/start
optional body: {"prompt":"bounded assignment"}

POST /api/terminals/<terminalId>/stop
```

Start preserves the record and tree edge, rejects an already-running record with `409`, and otherwise submits the supplied prompt or stored `initialInputDraft`. Stop gracefully ends the active PTY without deleting the terminal record. Creating a record with `tentacleId`/`initialInputDraft` and no `initialPrompt` is register-only. `sara` cannot start because its persisted `fleetProfileKind` is `bound-service`.

## Concurrency law

- Soft ceiling: 8 active Claude sessions machine-wide; hard ceiling: 10 across both octogent ports and interactive Claude work.
- Count active Claude sessions, not dormant records, Sara, Codex, or GLM processes.
- One summoned Claude child per officer by default. CEO owns priority and the global queue.
- Reserve recovery capacity for CEO and VaultAgent/interactive work; serialize singleton deploy/box work.
- A wake beyond the hard ceiling is queued and disclosed, never silently started.

## Files

| Path | Purpose |
|---|---|
| `fleet.json` | Version-2 role/profile contract |
| `tentacles/<id>/` | Canonical `CONTEXT.md`, `todo.md`, and `memory.md` seeds for standing roles and the four Claude profiles |
| `tentacles/vaultagent/` | Representation documentation only; never runner-spawnable |
| `worktree-claude-settings.json` | D5 deny template for ephemeral specialist worktrees |
| `../prompts/csuite-agent-init.md` | Dormant/wake, summon-profile, and concurrency doctrine |
| `../packages/core/src/application/fleetPlan.ts` | Pure manifest validation and create-plan builders |
| `../apps/api/src/fleetSpawn.ts` | Dry-run-by-default, operator-gated role runner |
| `../apps/api/src/fleetVerifyRuntime.ts` | Native verifier producer and fleet-root verdict notification adapter |

Sara deliberately has no Claude seed folder: her manifest record is a bound-service representation and roster changes must never reprovision the live service.

## Operator gate and verification

The runner remains dry-run by default and must not be pointed at a live daemon as part of a build/test lane.

```bash
pnpm fleet:spawn
pnpm fleet:spawn -- --execute
pnpm fleet:spawn -- --execute --verify
```

With `--verify` (or `OCTOGENT_FLEET_VERIFY=1`), the runner starts a separate Claude Code verifier under the fleet root, waits for its schema-validated verdict, and appends one pass/fail record to `<stateDir>/fleet-verify.log.jsonl`. The record contains the full audit prompt and a pointer to the verifier's unsummarized append-only transcript at `<stateDir>/state/transcripts/<verifierTerminalId>.jsonl`. The same verdict and trace pointer are sent to the fleet root through the native channel. `REJECT`, malformed output, timeout, and producer failure all fail closed; `OCTOGENT_FLEET_VERIFY_BLOCK_ON_FIXES=1` also blocks `APPROVE_WITH_FIXES`. The default verifier timeout is ten minutes and can be changed with `OCTOGENT_FLEET_VERIFY_TIMEOUT_MS`.

This is the live [D7] verify substrate. The A5 autonomous proposer remains gated behind FORK-A5-1: any future candidate space is limited to config, manifest, and prompt-template versions, never code, and activation remains a human decision.

Build lanes may validate the manifest, requests, seeds, API routes, and tests. Restart/rollout, live wake, live stop, profile registration, cutover, commit, and push are separate operator actions.

## Worktree deny parity

Ephemeral specialist worktrees still receive `fleet/worktree-claude-settings.json`. It denies destructive git/filesystem operations, network shell egress, privilege escalation, and secret-file reads/writes while allowing logical-unit commits. The settings file is staged immediately after worktree creation; the known pre-seed race remains an infrastructure limitation and does not authorize early edits.
