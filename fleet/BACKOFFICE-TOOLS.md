# Back-office tools — the fleet's :3001 "tools" seam (#45 W-ORCH-NATIVE, Phase 2)

> Authority: `$VAULT/40-Plans/Active/2026-06-30-W-ORCH-NATIVE-architecture-decision-doc.md` §8 (ruling D4 + the end-state) + `2026-06-30-W-ORCH-NATIVE-build-plan.md` **Phase 2**. Built 2026-07-04 on branch `feat/45-phase1` (MASTER-LIST r92).

Phase 2's end-state (decision doc §8): the retired `:3001` delegation engine collapses to a **back-office SERVICES layer** — Sara voice, CRM/waitlist, email/cadence, WhatsApp+`/cfo`, KB — that the octogent-native fleet **consumes as TOOLS, never modifies**. This directory implements that seam as a **curated tool registry + HTTP client + CLI command**. Zero `:3001` changes: it calls the *existing* back-office routes.

## Why a curated surface (not the existing `:3001` MCP server)

`:3001` already ships an MCP server (`server/mcp-server.ts`), but it mixes **engine tools** (`shazly_delegate` / `shazly_execute` / `shazly_chat` — the very engine #45 retires) with back-office tools. Exposing that whole surface to the fleet would let a tentacle call the retiring engine — a direct violation of `prompts/csuite-agent-init.md` § Delegation model. So the fleet gets a **curated back-office-only** surface: only the KEEP-list services (decision doc §3), never the engine.

## What's here

| Path | What |
|---|---|
| `../packages/core/src/application/backOfficeTools.ts` | Pure registry: each tool's name, `:3001` HTTP mapping, input schema + `buildBackOfficeRequest()` (validate args → transport-agnostic request plan). No I/O. Tests: `packages/core/tests/backOfficeTools.test.ts`. |
| `../apps/api/src/backOfficeClient.ts` | HTTP adapter: env config (fail-closed), `X-API-Key` auth, fetch. Tests: `apps/api/tests/backOfficeClient.test.ts`. |
| `../apps/api/src/cli.ts` | `octogent backoffice {list,describe,call}` command. |

## How a tentacle calls a back-office tool

The C-suite tentacles are Claude Code sessions (D8). The sanctioned path to back-office is this **whitelisted CLI command** — never `curl` (denied for specialist worktrees per `fleet/worktree-claude-settings.json`), never the `:3001` engine.

```bash
# from $OCTOGENT (octogent repo root)
node bin/octogent backoffice list                    # discover the tool surface
node bin/octogent backoffice describe crm_set_lead_stage   # HTTP mapping + input schema
node bin/octogent backoffice call crm_list_leads --args '{"stage":"qualified","limit":10}'
node bin/octogent backoffice call crm_create_lead --args '{"name":"Acme Srl","email":"a@b.co"}'
```

`call` needs two env vars (fail-closed — a missing var errors, it never makes an unauthenticated call):

| Env var | What |
|---|---|
| `COLLEGA_BACKOFFICE_BASE_URL` | `:3001` base, e.g. `http://127.0.0.1:3001` locally, or the Box-B tunnel URL (back-office moved to Box B at the r4 A→B cutover). No trailing slash needed. |
| `COLLEGA_BACKOFFICE_API_KEY`  | A `:3001` service-account API key (sent as `X-API-Key`). **Never commit it** — export it in the tentacle's shell / a gitignored env file. |

Output is JSON: `{ ok, status, toolName, mutates, data }`. `mutates:true` marks write ops — the fleet treats those as actions, not reads (D4 adversarial-verify applies to any state change a tentacle drives).

## Tool catalog (grounded against `server/routes/{crm,voice}.ts`)

**CRM / waitlist** (`routes/crm.ts`)
- `crm_list_leads` — GET `/api/crm/leads` (query: stage, tenant_id, limit, offset)
- `crm_get_lead` — GET `/api/crm/leads/:id`
- `crm_pipeline` — GET `/api/crm/pipeline` (query: tenant_id)
- `crm_list_lead_activities` — GET `/api/crm/leads/:id/activities`
- `crm_list_lead_appointments` — GET `/api/crm/leads/:id/appointments`
- `crm_create_lead` — POST `/api/crm/leads` **[write]** (name required)
- `crm_set_lead_stage` — POST `/api/crm/leads/:id/stage` **[write]**
- `crm_add_lead_activity` — POST `/api/crm/leads/:id/activities` **[write]**
- `crm_schedule_follow_up` — POST `/api/crm/leads/:id/follow-up` **[write]**

**Sara voice / receptionist** (`routes/voice.ts`)
- `voice_status` — GET `/api/voice/status`
- `voice_list_calls` — GET `/api/voice/calls` (query: limit)
- `voice_reception_mode` — GET `/api/voice/reception-mode`

Run `octogent backoffice list` for the live surface — the registry is the source of truth, this table mirrors it.

## Honest scope / cut-line (remaining Phase-2 work)

This milestone delivers the **seam** + the **CRM + Sara voice** tools completely. Deliberately **not** in this milestone:

- **WhatsApp + `/cfo`** — `/cfo` is a *signed WhatsApp-inbound command bridge* (`routes/public.ts` + `whatsapp/command-bridge.ts`), not a clean queryable REST route. Exposing it as a fleet tool needs a new read-only `:3001` endpoint (scope-gated: `:3001` changes only as the build plan requires, on branch `feat/45-phase2-tools`).
- **KB** — the CollegaRAG knowledge base is a *separate loopback MCP* on Box B (`:8000`, auth-on), not a `:3001` REST route; the fleet consumes it via its own MCP config, not this seam. (`:3001`'s `/api/corpora` is a memory-corpus surface, a different thing.)
- **email/cadence** — no read tool added yet; add in the same registry pattern when a use-case lands.
- **Quality parity (D4) harness** — the adversarial-verify *pattern* is already in `prompts/csuite-agent-init.md` § Delegation model; a reusable verify/eval **harness** (A5 evals) is the next Phase-2 milestone.
- **Live parity proof** — the build-plan Phase-2 verify ("fleet completes a real end-to-end delegation, adversarial-verify catches a planted error") is **operator-gated**: it needs the live fleet stood up (operator-gated) + the live Box-B `:3001` reachable. Build-complete ≠ proven-on-box — reground before asserting.

Adding a tool is additive: append a grounded `BackOfficeToolDefinition` to `backOfficeTools.ts` (verify the route exists in `server/routes/*` first — never advertise an endpoint the backend lacks) and it appears in `list`/`describe`/`call` automatically.
