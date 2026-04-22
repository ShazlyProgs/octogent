# Scanner directive: scan-tentacle-substrate

**Introduced**: Phase 6 Sustainability Layer per Plan v1.1 §6.2 + §6.4

## Scope

Verify that every tentacle init prompt at `$REPOS/Agents/octogent/apps/api/src/prompts/*-init.md` contains a SUBSTRATE block matching the F2 template. Flag tentacles whose spawn prompts omit substrate injection (→ C3 fragmentation drift).

## Ground truth

- Plan v1.1 §6.2 F2 specification
- SUBSTRATE template (from Plan v1.1 §6.2):
  ```markdown
  ## SUBSTRATE (read at boot, before any work)

  Authority anchors for this tentacle. Read in order:

  1. **Unified Big Picture** — $VAULT/50-Reconstruction/04-UNIFIED-BIG-PICTURE.md §<sections>
  2. **Strategic Plan v1.1** — $VAULT/50-Reconstruction/05-STRATEGIC-PLAN-v1.1.md §<sections>
  3. **Critical Invariants** — $ORCHESTRATION/.claude-flow/critical-invariants.md (full)
  4. **Ship-gate** — Plan v1.1 §5.<tentacle-gate-subsection>
  5. **Your scope boundary** — <explicit>

  After reading, confirm READY with a 1-paragraph summary of your mandate + scope.
  ```

## Method

1. List `$REPOS/Agents/octogent/apps/api/src/prompts/*-init.md` (all tentacle + agent init templates)
2. For each template:
   - Check presence of `## SUBSTRATE` header (case-insensitive match)
   - Verify 5 numbered anchor items present with expected labels (Big Picture, Plan v1.1, Critical Invariants, Ship-gate, scope boundary)
   - Verify `$VAULT/50-Reconstruction/` path appears for items 1 + 2
3. Flag templates missing SUBSTRATE block OR with incomplete anchor structure

**NOTE** (Phase 6 deferral): during transition period, templates without SUBSTRATE may exist; Phase 6 §F2 defers runtime wiring to post-Reconstruction. Scanner runs in ADVISORY mode until Octogent runtime wires `substrateAnchors` data model (tracked as Post-Reconstruction queue). Findings are tier-2 during transition; promote to tier-1 after Mohamed confirms F2 runtime live.

## Output

`$VAULT/Claude Cowork/vault-sync/<RUN_ID>/findings-tentacle-substrate.json`

Per finding:
```json
{
  "scanner": "tentacle-substrate",
  "file": "<init-template-path>",
  "line": <integer or null>,
  "severity": "tier-1" | "tier-2",
  "finding": "SUBSTRATE block missing OR incomplete",
  "expected": "F2 template with 5 numbered anchors per Plan v1.1 §6.2",
  "actual": "<section-headers-found or '(none)'>",
  "proposed_fix": "Inject SUBSTRATE block per F2 template; populate <sections> from substrateAnchors config",
  "evidence": "<grep output showing current template structure>"
}
```

## Signal

`octogent channel send terminal-2 "DONE scanner=tentacle-substrate findings=<N> run=<RUN_ID>" --from <your-terminal-id>`

## Non-actions

- Do not modify init templates (VaultAgent adds SUBSTRATE block per F2 rollout; scanner is detective only)
- Do not flag non-tentacle prompts (e.g., one-shot agent prompts that aren't session-boot templates)
- Do not require perfect template match — structural presence (SUBSTRATE header + 5 anchors) is sufficient; exact wording can vary per tentacle scope

## Pairs with

- Plan v1.1 §6.2 F2 template
- Phase 3 D10 (Octogent adoption without substrate injection) — this scanner closes the detective loop
