// Test isolation guard (P30, 2 Nov 2026): never touch the live ~/.octogent or port 8788.
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OCTOGENT_REAL_HOME) process.env.OCTOGENT_REAL_HOME = homedir();
if (!process.env.OCTOGENT_TEST_ISOLATED) {
  const home = mkdtempSync(join(tmpdir(), "octogent-test-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OCTOGENT_TEST_ISOLATED = "1";
}
process.env.OCTOGENT_API_PORT = process.env.OCTOGENT_TEST_API_PORT ?? "18788";
const resolved = join(homedir(), ".octogent").toLowerCase();
const real = join(process.env.OCTOGENT_REAL_HOME, ".octogent").toLowerCase();
if (resolved === real) {
  throw new Error(`Test isolation guard: tests resolved the real ${real}. Refusing to run.`);
}
