import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** P41: deleting a tentacle quarantines it and tombstones it so no scan brings it back (OCTO_DELETE_TOMBSTONE=1). */
export const isDeleteTombstoneEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.OCTO_DELETE_TOMBSTONE === "1";

export type TentacleTombstone = { tentacleId: string; deletedAt: string; reason: string; quarantinedTo: string | null };

const tombstonePath = (stateDir: string) => join(stateDir, "state", "deleted-tentacles.json");

export const readTentacleTombstones = (stateDir: string): Record<string, TentacleTombstone> => {
  try {
    const raw = JSON.parse(readFileSync(tombstonePath(stateDir), "utf8")) as { tombstones?: Record<string, TentacleTombstone> };
    return raw && typeof raw.tombstones === "object" && raw.tombstones !== null ? raw.tombstones : {};
  } catch {
    return {};
  }
};

const writeTombstones = (stateDir: string, tombstones: Record<string, TentacleTombstone>): void => {
  mkdirSync(join(stateDir, "state"), { recursive: true });
  const file = tombstonePath(stateDir);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, tombstones }, null, 2)}\n`);
  renameSync(tmp, file);
};

export const isTentacleTombstoned = (stateDir: string, tentacleId: string): boolean =>
  Object.hasOwn(readTentacleTombstones(stateDir), tentacleId);

export const clearTentacleTombstone = (stateDir: string, tentacleId: string): void => {
  const all = readTentacleTombstones(stateDir);
  if (!Object.hasOwn(all, tentacleId)) return;
  delete all[tentacleId];
  writeTombstones(stateDir, all);
};

/**
 * Move <workspace>/.octogent/tentacles/<id> into <stateDir>/state/deleted-tentacles/<id>-<stamp> (never rm)
 * and record a tombstone. Git worktrees/branches are never touched.
 */
export const quarantineDeckTentacleFolder = (
  workspaceCwd: string,
  stateDir: string,
  tentacleId: string,
  reason: string,
  now: Date = new Date(),
): TentacleTombstone => {
  const src = join(workspaceCwd, ".octogent", "tentacles", tentacleId);
  let quarantinedTo: string | null = null;
  if (existsSync(src)) {
    const qRoot = join(stateDir, "state", "deleted-tentacles");
    mkdirSync(qRoot, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    let dest = join(qRoot, `${tentacleId}-${stamp}`);
    for (let i = 1; existsSync(dest); i++) dest = join(qRoot, `${tentacleId}-${stamp}-${i}`);
    renameSync(src, dest);
    quarantinedTo = dest;
  }
  const all = readTentacleTombstones(stateDir);
  const stone: TentacleTombstone = { tentacleId, deletedAt: now.toISOString(), reason, quarantinedTo };
  all[tentacleId] = stone;
  writeTombstones(stateDir, all);
  return stone;
};
