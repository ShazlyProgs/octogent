# Scanner directive: scan-reconstruction-integrity

**Introduced**: Phase 6 Sustainability Layer per Plan v1.1 §6.4

## Scope

Verify Grand Unified Reconstruction substrate integrity:

1. All 7 phase artifacts present at `$VAULT/50-Reconstruction/`:
   - `00-RECONSTRUCTION-CHARTER.md`
   - `01-SESSION-LEDGER.md`
   - `02-PIVOT-TIMELINE.md`
   - `03-DIVERGENCE-DIAGNOSIS.md`
   - `04-UNIFIED-BIG-PICTURE.md`
   - `05-STRATEGIC-PLAN-v1.1.md`
   - `06-SUSTAINABILITY-LAYER.md`
   - `07-VAULT-STRUCTURE-REDESIGN.md` (optional; present only if triggered)
2. `FREEZE-EXCEPTIONS.md` present + each EX-NNN entry has Phase 3 classification (after Phase 3 close)
3. Each phase artifact indexed in:
   - `$VAULT/ROADMAP.md` (as Tier 0 entries or Reconstruction banner)
   - `$MEMORY/MEMORY.md` (under Reconstruction Era section)
   - `$ORCHESTRATION/docs/DEVELOPMENT_STATE.md` (Session 64+ handoff)
4. Each phase artifact line-count NOT compressed below last-known fidelity (detects compression cascade drift)

## Ground truth

- Charter anti-loss rules: Charter §Commit discipline
- Plan v1.1 §6.4 scanner spec
- Line-count thresholds (minimum — any drop below = drift):
  - Charter: 240 lines
  - Session Ledger: 250 lines (grows over time)
  - Pivot Timeline: 160 lines
  - Divergence Diagnosis: 240 lines
  - Unified Big Picture: 600 lines
  - Strategic Plan v1.1: 900 lines
  - Sustainability Layer: 150 lines

## Method

1. List `$VAULT/50-Reconstruction/*.md`
2. Verify each of the 7 (8 with Phase 7) expected filenames
3. For each, check line count vs threshold (`wc -l` or equivalent)
4. Verify indexing:
   - `grep -l "50-Reconstruction" $VAULT/ROADMAP.md` → should find Reconstruction banner or index entries
   - `grep -l "50-Reconstruction" $MEMORY/MEMORY.md` → should find Reconstruction Era section
   - `grep -l "Reconstruction" $ORCHESTRATION/docs/DEVELOPMENT_STATE.md` → should find Session 64+ handoff
5. For FREEZE-EXCEPTIONS.md: count `EX-NNN` entries; verify each has "Phase 3 classification:" field populated (not blank, not `PENDING`) after Phase 3 close date

## Output

`$VAULT/Claude Cowork/vault-sync/<RUN_ID>/findings-reconstruction-integrity.json`

Per finding:
```json
{
  "scanner": "reconstruction-integrity",
  "file": "<phase-artifact-path or index-file-path>",
  "line": null,
  "severity": "tier-1" | "tier-2",
  "finding": "<Missing artifact | Below fidelity threshold | Index entry missing | EX-NNN unclassified>",
  "expected": "<what should be present>",
  "actual": "<what's missing / observed count>",
  "proposed_fix": "<regenerate artifact | add index entry | classify EX-NNN>",
  "evidence": "<file-path or grep-output>"
}
```

## Signal

`octogent channel send terminal-2 "DONE scanner=reconstruction-integrity findings=<N> run=<RUN_ID>" --from <your-terminal-id>`

## Non-actions

- Do not regenerate phase artifacts; escalate via findings
- Do not add index entries; escalate via findings (VaultAgent or Mohamed authorizes)
- Do not remove Phase 7 absence as a finding unless ≥ 3 SD-NN flags present in Charter Appendix A

## Pairs with

- Charter §Commit discipline (redundant indices rule)
- F4 scanner scheduling (nightly 02:00 Rome)
