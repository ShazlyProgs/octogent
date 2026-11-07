import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteDeckTentacle, readDeckTentacles, removeDeckStateEntry } from "../src/deck/readDeckTentacles";
import { isDeleteTombstoneEnabled, isTentacleTombstoned, quarantineDeckTentacleFolder, readTentacleTombstones } from "../src/deck/tentacleTombstones";

const mk = (ws: string, id: string) => {
  const d = join(ws, ".octogent", "tentacles", id); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "CONTEXT.md"), `# ${id}\n\nworker ${id}\n`); writeFileSync(join(d, "todo.md"), "# todo\n");
};
let ws = ""; let st = ""; const prev = process.env.OCTO_DELETE_TOMBSTONE;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "p41-ws-")); st = mkdtempSync(join(tmpdir(), "p41-st-"));
  mkdirSync(join(st, "state"), { recursive: true });
  writeFileSync(join(st, "state", "deck.json"), JSON.stringify({ tentacles: { ghost: { status: "idle" }, keep: { status: "idle" } } }));
  mk(ws, "ghost"); mk(ws, "keep");
});
afterEach(() => { if (prev === undefined) delete process.env.OCTO_DELETE_TOMBSTONE; else process.env.OCTO_DELETE_TOMBSTONE = prev; });

describe("P41 delete tombstone", () => {
  it("flag defaults off", () => { delete process.env.OCTO_DELETE_TOMBSTONE; expect(isDeleteTombstoneEnabled()).toBe(false); });
  it("flag off: deck delete behaves as before (folder removed, no tombstone)", () => {
    delete process.env.OCTO_DELETE_TOMBSTONE;
    expect(deleteDeckTentacle(ws, "ghost", st).ok).toBe(true);
    expect(existsSync(join(ws, ".octogent", "tentacles", "ghost"))).toBe(false);
    expect(existsSync(join(st, "state", "deleted-tentacles.json"))).toBe(false);
  });
  it("flag on: deck delete quarantines (never rm) and tombstones", () => {
    process.env.OCTO_DELETE_TOMBSTONE = "1";
    expect(deleteDeckTentacle(ws, "ghost", st).ok).toBe(true);
    const stone = readTentacleTombstones(st).ghost;
    expect(stone?.quarantinedTo && existsSync(join(stone.quarantinedTo, "CONTEXT.md"))).toBe(true);
    expect(readDeckTentacles(ws, st).map((t) => t.tentacleId)).toEqual(["keep"]);
    expect(JSON.parse(readFileSync(join(st, "state", "deck.json"), "utf8")).tentacles.ghost).toBeUndefined();
  });
  it("flag on: a re-appearing folder for a tombstoned id stays hidden", () => {
    process.env.OCTO_DELETE_TOMBSTONE = "1";
    quarantineDeckTentacleFolder(ws, st, "ghost", "test"); mk(ws, "ghost");
    expect(readDeckTentacles(ws, st).map((t) => t.tentacleId)).toEqual(["keep"]);
  });
  it("flag off: tombstones are ignored by the reader", () => {
    process.env.OCTO_DELETE_TOMBSTONE = "1"; quarantineDeckTentacleFolder(ws, st, "ghost", "test"); mk(ws, "ghost");
    delete process.env.OCTO_DELETE_TOMBSTONE;
    expect(readDeckTentacles(ws, st).map((t) => t.tentacleId).sort()).toEqual(["ghost", "keep"]);
  });
  it("quarantine never collides and keeps both copies", () => {
    const d = new Date("2026-11-04T19:30:00Z");
    const a = quarantineDeckTentacleFolder(ws, st, "ghost", "a", d); mk(ws, "ghost");
    const b = quarantineDeckTentacleFolder(ws, st, "ghost", "b", d);
    expect(a.quarantinedTo).not.toBe(b.quarantinedTo);
    expect(existsSync(a.quarantinedTo as string) && existsSync(b.quarantinedTo as string)).toBe(true);
  });
  it("missing folder still tombstones (terminal-only tentacle)", () => {
    expect(quarantineDeckTentacleFolder(ws, st, "nofolder", "t").quarantinedTo).toBeNull();
    expect(isTentacleTombstoned(st, "nofolder")).toBe(true);
  });
  it("removeDeckStateEntry drops only that entry", () => {
    removeDeckStateEntry(st, "ghost");
    expect(Object.keys(JSON.parse(readFileSync(join(st, "state", "deck.json"), "utf8")).tentacles)).toEqual(["keep"]);
  });
});
