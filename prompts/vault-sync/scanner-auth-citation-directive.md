# Scanner directive: scan-auth-citation

**Introduced**: Phase 6 Sustainability Layer per Plan v1.1 §6.1 + §6.4

## Scope

Scan `feat(...)`, `fix(...)`, `refactor(...)` commits in the vault repo (plus nested orchestration repo if detected) since last-run marker. Flag commits lacking an `Auth:` line matching Plan v1.1 §3.5 grammar.

**Scope window**: commits since `.vault-sync/last-auth-scan.marker` (create if missing; initialize to one week ago).

## Ground truth

- **Grammar** per Plan v1.1 §3.5:
  ```
  Auth: <ref> [ | <ref> ... ]
  ref := PLAN §N.N | I-NN | PAT-LABEL | ADR-NNN | RECON §N
  ```
- **Exempt commit types**: `docs(...)`, `chore(...)`, `test(...)`, `feat(recon/phase-N): ...` (Reconstruction self-anchor), `recon(...)`
- **Invariant**: no `feat/fix/refactor` commit post-F1-install should lack valid Auth

## Validation regex

```
^Auth: (PLAN §\d+(\.\d+)*|I-\d+|PAT-[A-Z0-9_-]+|ADR-\d+|RECON §\d+)(\s*\|\s*(PLAN §\d+(\.\d+)*|I-\d+|PAT-[A-Z0-9_-]+|ADR-\d+|RECON §\d+))*$
```

## Method

1. Run `git log --since=<marker> --pretty=format:'%H|%s|%b---END---'` in vault repo
2. Split output on `---END---`; for each commit:
   - Extract subject line → check if type matches `feat|fix|refactor` (and not exempt prefix)
   - Scan body for `Auth:` line matching grammar regex
   - If no valid Auth → emit finding
3. Update `.vault-sync/last-auth-scan.marker` with timestamp of latest processed commit

## Output

Write findings to `$VAULT/Claude Cowork/vault-sync/<RUN_ID>/findings-auth-citation.json`.

Each finding:
```json
{
  "scanner": "auth-citation",
  "file": "<commit-SHA>",
  "line": null,
  "severity": "tier-1",
  "finding": "Commit missing or malformed Auth field",
  "expected": "Auth: <PLAN §N.N | I-NN | PAT-LABEL | ADR-NNN>",
  "actual": "<what's in commit body, or '(none)'>",
  "proposed_fix": "Amend commit with valid Auth line OR add via interactive rebase post-review",
  "evidence": "<commit subject line>"
}
```

## Signal

`octogent channel send terminal-2 "DONE scanner=auth-citation findings=<N> run=<RUN_ID>" --from <your-terminal-id>`

## Non-actions

- Do not modify commits (historical rewrite = forbidden)
- Do not block future commits (that's F1 hook's job; this scanner is DETECTIVE control complementing F1 PREVENTIVE)
- Do not check exempt commit types (docs / chore / test / recon-phase)

## Pairs with

- **F1** commit-msg hook (preventive); this scanner is detective for history + bypass cases (`SHIP_GATE_OVERRIDE=1` or pre-F1-install commits)
