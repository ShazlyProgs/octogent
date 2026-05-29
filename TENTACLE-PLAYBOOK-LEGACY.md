# Octogent Tentacle Playbook

> Repeatable pattern for parallel Claude Code work via Octogent.
> Established 2026-04-19. This is the canonical workflow.

---

## How Octogent works (3-bullet summary)

- Each tentacle = one terminal in the dashboard at `http://127.0.0.1:8787`
- Octogent **auto-creates an isolated git worktree** per tentacle at `VS Code Repos/.octogent/worktrees/terminal-N/`, on a `octogent/terminal-N` branch
- All tentacles share the same disk / vault but commit to **separate branches** — no collision

## Launch flow (every session)

1. Double-click `start-octogent.bat` in this folder
2. Wait for `Octogent listening on http://127.0.0.1:8787`
3. Open `http://127.0.0.1:8787`
4. For each domain you want to parallelize: spawn a terminal, paste its tentacle prompt from below

## When you need a NEW worktree (rare)

Octogent provides 5 pre-provisioned terminals. If you need more, spawn one in the UI — Octogent creates the worktree automatically. Do NOT manually `git worktree add` — fight Octogent's model.

## Coordination rules

- **One domain per tentacle.** Strict exclusion zones in each prompt below — never let a tentacle touch outside its scope.
- **No cross-tentacle file edits.** If two tentacles need to modify the same file, pause one and resolve in the other first.
- **Commit per logical unit on `octogent/terminal-N`.** Don't bundle 5 changes into one commit.
- **Never `git push` without explicit human approval** (currently 233+ commits held on main).
- **Merge upstream when stable**: from main worktree, `git merge octogent/terminal-N --no-ff`. Then resolve any conflicts.
- **The coordinator session** (this Claude Code instance, NOT in Octogent) handles cross-tentacle questions. Bring strategic decisions back here.

---

## TENTACLE A — Website finalization

**Domain:** Iubenda wizard → URL substitution → cookie banner → IT/DE translation → switcher reactivation
**Deadline:** none hard, but Iubenda compliance is legally required for the live site
**Files in scope:** `brand/website/**`, `memory/project_website_hosting.md`

### Paste this into Tentacle A:

```
You are the WEBSITE tentacle for the Collega AI marketing site. Your scope is locked.

READ FIRST (in order, top to bottom):
1. ~/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/project_website_hosting.md
2. .claude-flow/context-warnings.md
3. ~/.claude/plans/very-good-now-ultrathink-merry-starlight.md (historical plan, not authoritative — memory above is)

EXCLUSION ZONE — only edit:
- Agents/CollegaAgents_CollegaOrchestration/brand/website/**
- ~/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/project_website_hosting.md
NEVER touch: server/, frontend/, agents/, docs/, brand/final/, brand/concepts/, brand/context/, anything Twilio/voice.

BRANCH RULE: you are on octogent/terminal-N (Octogent's auto-worktree). Commit per logical edit on this branch. NEVER `git push`. When stable, the coordinator will merge to main.

CRITICAL PATH (Path A — Iubenda first, translation second):
1. Resume Iubenda Advanced wizard at the "Website owner" step (Mohamed has the dashboard open)
2. Publish Privacy Policy / Cookie Policy / T&C in IT primary + EN + DE → grab issued URLs
3. Activate Cookie Solution banner → grab JS snippet
4. In brand/website/index.html: search `data-iubenda="privacy|cookie|terms"`, replace each `href="#"` with the issued URL. Inject Cookie Solution banner JS in <head>.
5. Mohamed re-uploads index.html to /www/ via Register.it File Manager
6. Mohamed triggers Iubenda re-scan — should clear ALL CDN warnings
7. Create privacy@collegaai.com alias in admin.google.com → Users → Mohamed → Email aliases
8. Translate index.html → /www/it/index.html and /www/de/index.html (use absolute paths to /fonts/, /vendor/, /logos/ to share assets)
9. Reactivate IT/DE in switcher: <span class="nav-lang-opt is-pending"> → <a href="/it/" class="nav-lang-opt"> + same for DE. Add JS to highlight active locale based on <html lang="...">
10. Final QA in incognito at IT/EN/DE geo (VPN or browser geo-spoof)

FIRST ACTION: ask Mohamed to confirm the Iubenda dashboard is open and report which step the wizard is on. Then walk him through the "Website owner" form using the Ditta individuale entity facts from the website hosting memory.
```

---

## TENTACLE B — Twilio Italian number + Phone Call Tool

**Domain:** Twilio +39 number, ElevenLabs CAI Italian config, IFAT demo prep
**Deadline:** **IFAT industrial fair 2026-05-04 to 05-08** (~2 weeks)
**Files in scope:** `server/elevenlabs-cai.ts`, `server/routes/voice.ts`, `server/call-handler/**`, `agents/call-receptionist.md`, related memory files

### Paste this into Tentacle B:

```
You are the TWILIO + PHONE CALL tentacle. Hard deadline: IFAT industrial fair 2026-05-04 to 05-08.

READ FIRST (in order):
1. ~/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/project_phone_call_tool.md
2. ~/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/project_partita_iva_blockers.md (P.IVA NOW ACTIVE — IT13441320010, ditta individuale)
3. ~/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/project_raspberry_pi_voice_agent.md
4. Agents/CollegaAgents_CollegaOrchestration/agents/call-receptionist.md
5. Agents/CollegaAgents_CollegaOrchestration/.claude-flow/context-warnings.md

EXCLUSION ZONE — only edit:
- Agents/CollegaAgents_CollegaOrchestration/server/elevenlabs-cai.ts
- Agents/CollegaAgents_CollegaOrchestration/server/routes/voice.ts
- Agents/CollegaAgents_CollegaOrchestration/server/call-handler/**
- Agents/CollegaAgents_CollegaOrchestration/agents/call-receptionist.md
- ~/.claude/projects/C--Users-mohamed-elshazly-Obsidian-Vault/memory/project_phone_call_tool.md
- New IFAT-prep docs you create (place under brand/ifat-2026/ if needed)
NEVER touch: brand/website/, frontend/, server modules outside voice/call scope, anything web-design-related.

BRANCH: you are on octogent/terminal-N. Commit per logical change. NEVER `git push`.

CRITICAL PATH:
1. Mohamed purchases Twilio Italian +39 number using ditta individuale entity (P.IVA IT13441320010, C.F. LSHMMD94P11Z336V, Corso Eusebio Giambone 1, 10134 Torino). Twilio Regulatory Bundle attestation may take ~24-48h.
2. Configure the Twilio number → ElevenLabs CAI inbound webhook (extend existing US flow at server/routes/voice.ts)
3. ElevenLabs CAI: ensure Italian is the primary language for the IT number (English/German switching preserved per current persona)
4. Live-test inbound +39 call end-to-end: audio quality, latency, transcript capture, post-call vault writer
5. IFAT demo prep:
   - Demo script (3-min flow: caller → live transcription → agent response → post-call task creation)
   - Talking points for Mohamed at the booth
   - Fallback plan if network drops
   - Business cards with the +39 number for handouts (design exists at brand/concepts/round-1/business-card.html)
6. Update memory/project_phone_call_tool.md with IT number live status + IFAT readiness

FIRST ACTION: confirm with Mohamed which Twilio account + payment method, then walk through the +39 number purchase + Regulatory Bundle attestation.
```

---

## TENTACLE C — Product Development (Phase 59.4 + live test 59.1-59.3)

**Domain:** Close Objective A — live-test the Phase 59 sub-phases shipped Session 55, then design + ship Phase 59.4
**Deadline:** none hard; this is the next milestone in the roadmap
**Files in scope:** `server/`, `frontend/`, `agents/`, `docs/`, tests

### Paste this into Tentacle C:

```
You are the PRODUCT DEV tentacle. Mission: close Objective A by shipping Phase 59.4 (multi-domain task coordination), AND live-validate Sessions 55's Phase 59.1/59.2/59.3 work in the browser before designing 59.4.

READ FIRST (in order):
1. Agents/CollegaAgents_CollegaOrchestration/docs/DEVELOPMENT_STATE.md — start at the topmost "🎯 Session 56 Handoff" section
2. Agents/CollegaAgents_CollegaOrchestration/docs/ROADMAP.md — focus on Phase 59 (current sub-phases) + Phase 60 (next)
3. Agents/CollegaAgents_CollegaOrchestration/docs/decisions/*.md — 14 ADRs constrain implementation choices
4. Agents/CollegaAgents_CollegaOrchestration/CLAUDE.md (project root) — full architecture
5. Agents/CollegaAgents_CollegaOrchestration/docs/CODEBASE_MAP.md — file index
6. Agents/CollegaAgents_CollegaOrchestration/.claude-flow/context-warnings.md

EXCLUSION ZONE — full server/, frontend/, agents/, docs/, server/__tests__/.
NEVER touch: brand/website/, anything Twilio/voice-related, the website hosting memory file.

BRANCH: you are on octogent/terminal-N. Commit per logical change. NEVER `git push` (233+ commits already held on main — Mohamed decides timing).

VALIDATION GAPS TO CLOSE FIRST (before designing 59.4):
- BossView feedback textarea + approve/reject — exercise live in browser
- AgentDetail reject-and-rerun flow — exercise live in browser
- Chat inline DelegationProposalCard — verify a C-suite agent emits the [DELEGATE] block
- Restart dev server first: `cd Agents/CollegaAgents_CollegaOrchestration && npm run dev` (was killed mid-Session 55 by tsx-watch choke)

CRITICAL PATH:
1. Restart dev server, open the relevant pages in browser, exercise the 59.1/59.2/59.3 features. Report any field bugs.
2. Fix anything broken. Commit fixes.
3. Design Phase 59.4: a single task that spans multiple agents/projects. Example: "update Collega backend API and pixel-agents extension to use the new schema." Requires CTO-like planner that dispatches across project boundaries with correct project_id / cwd per sub-execution.
4. Implement, test (vitest), live-validate.
5. Update DEVELOPMENT_STATE.md with Session 57 handoff section at the top.
6. Once Mohamed green-lights, push the backlog.

FIRST ACTION: cd into the project, restart the dev server, open BossView, and exercise the Session 55 features. Report what's broken before touching 59.4.
```

---

## How to add a NEW domain in the future

1. Add a new tentacle prompt block in this file (copy structure of A/B/C above)
2. Spawn a terminal in Octogent
3. Paste the new prompt
4. Coordinate with the other tentacles via the coordinator session

## Coordinator (this is the meta layer)

The coordinator is **NOT inside Octogent** — it's a separate Claude Code session you keep open in your normal terminal. Use it for:
- Cross-tentacle questions ("should the website link to the Twilio +39 number?")
- Strategy decisions
- When a tentacle finishes and you need to merge to main
- When two tentacles' scopes start to overlap

The coordinator owns the playbook (this file), the memory updates, and the merge strategy.
