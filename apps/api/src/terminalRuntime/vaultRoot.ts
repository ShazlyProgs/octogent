import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Detect the vault root by walking up from a starting cwd.
 * The vault is identified by the presence of `.shazly/MANIFEST.md` — the
 * canonical manifest Mohamed's vault-aware agents read at boot. If not found,
 * returns undefined (non-vault project).
 *
 * Spawning a child Claude with cwd=vaultRoot restores capability parity with
 * Mohamed's pre-octogent Claude Code experience: the auto-memory directory,
 * claude-mem history, CLAUDE.md chain, and governance hooks all key to the
 * same path the vault has been using.
 */
export const detectVaultRoot = (startFrom: string): string | undefined => {
  let current = startFrom;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, ".shazly", "MANIFEST.md"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
};
