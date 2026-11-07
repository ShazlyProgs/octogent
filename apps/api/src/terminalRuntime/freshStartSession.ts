/**
 * P42: fresh-start session reset (OCTO_FRESH_START_RESET_SESSION=1).
 * Clears stale codexThreadId/claudeSessionId on POST /start so logTruth cannot
 * latch against a prior session's task_complete; discovers and persists the new id.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const isFreshStartResetSessionEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.OCTO_FRESH_START_RESET_SESSION === "1";

export type PreviousSessionId = {
  at: string;
  codexThreadId?: string;
  claudeSessionId?: string;
};

export const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLAUDE_SESSION_ID_RE = CODEX_THREAD_ID_RE;

const PREV_CAP = 10;

/** Archive current provider session ids, then clear them. Returns true if anything changed. */
export const resetSessionIdsForFreshStart = <
  T extends {
    codexThreadId?: string;
    claudeSessionId?: string;
    previousSessionIds?: PreviousSessionId[];
  },
>(
  terminal: T,
  atIso: string = new Date().toISOString(),
): boolean => {
  const prev: PreviousSessionId = { at: atIso };
  let changed = false;
  if (typeof terminal.codexThreadId === "string" && terminal.codexThreadId) {
    prev.codexThreadId = terminal.codexThreadId;
    delete terminal.codexThreadId;
    changed = true;
  }
  if (typeof terminal.claudeSessionId === "string" && terminal.claudeSessionId) {
    prev.claudeSessionId = terminal.claudeSessionId;
    delete terminal.claudeSessionId;
    changed = true;
  }
  if (!changed) return false;
  const list = Array.isArray(terminal.previousSessionIds) ? [...terminal.previousSessionIds] : [];
  list.push(prev);
  terminal.previousSessionIds = list.slice(-PREV_CAP);
  return true;
};

/** Newest Codex thread lock (or rollout name) whose mtime is at/after afterMs. */
export const discoverCodexThreadId = (input: {
  afterMs: number;
  home?: string;
  nowMs?: number;
}): string | null => {
  const home = input.home ?? homedir();
  const after = input.afterMs - 2_000; // small skew for clock/fs
  const before = (input.nowMs ?? Date.now()) + 60_000;
  const candidates: { id: string; mtimeMs: number }[] = [];

  const locksDir = join(home, ".codex", "thread-writer-locks");
  if (existsSync(locksDir)) {
    for (const name of readdirSync(locksDir)) {
      const m = /^([0-9a-f-]{36})\.lock$/i.exec(name);
      const lockId = m?.[1];
      if (!lockId || !CODEX_THREAD_ID_RE.test(lockId)) continue;
      const st = statSync(join(locksDir, name));
      if (st.mtimeMs >= after && st.mtimeMs <= before) candidates.push({ id: lockId, mtimeMs: st.mtimeMs });
    }
  }

  const sessionsRoot = join(home, ".codex", "sessions");
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || !existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth - 1);
      else {
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(ent.name);
        const fileId = m?.[1];
        if (!fileId || !CODEX_THREAD_ID_RE.test(fileId)) continue;
        try {
          const st = statSync(p);
          if (st.mtimeMs >= after && st.mtimeMs <= before) candidates.push({ id: fileId, mtimeMs: st.mtimeMs });
        } catch { /* skip */ }
      }
    }
  };
  walk(sessionsRoot, 4);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.id;
};

/** Newest Claude session jsonl created/modified at/after afterMs (optional cwd path fragment). */
export const discoverClaudeSessionId = (input: {
  afterMs: number;
  home?: string;
  nowMs?: number;
  pathHint?: string | null;
}): string | null => {
  const home = input.home ?? homedir();
  const after = input.afterMs - 2_000;
  const before = (input.nowMs ?? Date.now()) + 60_000;
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return null;
  const candidates: { id: string; mtimeMs: number }[] = [];
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    if (input.pathHint && !proj.name.toLowerCase().includes(input.pathHint.toLowerCase().replace(/[^a-z0-9]+/gi, "-").slice(0, 24))) {
      // soft filter only when hint matches something; otherwise keep scanning all
    }
    const dir = join(root, proj.name);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.replace(/\.jsonl$/i, "");
      if (!CLAUDE_SESSION_ID_RE.test(id)) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.mtimeMs >= after && st.mtimeMs <= before) candidates.push({ id, mtimeMs: st.mtimeMs });
      } catch { /* skip */ }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.id;
};

/** P42 latch guard: a completion dated before this session started is from a prior session — ignore. */
export const isStaleLatchEvent = (eventAtIso: string | null | undefined, startedAtMs: number | null | undefined): boolean => {
  if (startedAtMs == null || !Number.isFinite(startedAtMs) || !eventAtIso) return false;
  const ev = Date.parse(eventAtIso);
  return Number.isFinite(ev) && ev < startedAtMs;
};
