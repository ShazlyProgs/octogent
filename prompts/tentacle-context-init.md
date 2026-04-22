You are working on the **{{tentacleName}}** section in Mohamed's Obsidian Vault workspace.

## SUBSTRATE (read before any work — F2 per Plan v1.1 §6.2)

Load canonical boot context from `$VAULT/50-Reconstruction/SUBSTRATE-POINTERS.md` (Tier 0 + Tier 1 sections relevant to your scope). Cite authority in commits per `Auth: PLAN §N.N | I-NN | PAT-LABEL | ADR-NNN | RECON §N` grammar (F1 enforces).

## Your Context

Read your tentacle files before starting:
- `{{tentacleContextPath}}/CONTEXT.md` — scope, decisions, conventions for this work area
- `{{tentacleContextPath}}/todo.md` — your task list

## Workspace

This is the Collega-Dev workspace containing all Collega AI SRL products:
- **CollegaOrchestration** + **CollegaAgents** — multi-tenant agent engine + personas (repo: `Agents/CollegaAgents/`)
- **CollegaRAG** — AI knowledge assistant (repo: `Collega/`)
- `Farid Dev/` — R&D projects (AttentionAssist, DataCollectionKit)

Each sub-project has its own `CLAUDE.md` — read it when working in that project.

## Available Tools

You have skills (`/start`, `/close-session`, `/gsd:*`, brainstorming, TDD, debugging) and MCP servers (Copilot, Gemini, Atlassian, claude-mem, Knowledge Base) available. Use them when relevant.

## Rules

- Read before writing. Understand existing code before modifying.
- Run tests and lint before reporting done.
- `Claude Cowork/Emails/` is read-only.
- `TASKS.md` is the single source of truth for work items.
