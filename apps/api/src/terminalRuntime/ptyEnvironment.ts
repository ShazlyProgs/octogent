import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const createShellEnvironment = (options?: { octogentSessionId?: string }) => {
  // A daemon launched from an agent harness or CI shell inherits
  // color-suppressing vars (e.g. NO_COLOR=1), which NO_COLOR-spec-compliant
  // CLIs honor over COLORTERM — every session would render monochrome and
  // user input becomes indistinguishable from agent output in the UI.
  const COLOR_SUPPRESSING_KEYS = new Set(["NO_COLOR", "FORCE_COLOR"]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !COLOR_SUPPRESSING_KEYS.has(key)) {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (options?.octogentSessionId) {
    env.OCTOGENT_SESSION_ID = options.octogentSessionId;
  }
  return env;
};

export const ensureNodePtySpawnHelperExecutable = () => {
  if (process.platform === "win32") {
    return;
  }

  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    const packageDir = dirname(packageJsonPath);
    const helperCandidates = [
      join(packageDir, "build", "Release", "spawn-helper"),
      join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    ];

    for (const helperPath of helperCandidates) {
      if (!existsSync(helperPath)) {
        continue;
      }

      const currentMode = statSync(helperPath).mode;
      if ((currentMode & 0o111) !== 0) {
        continue;
      }

      chmodSync(helperPath, currentMode | 0o755);
    }
  } catch {
    // Let node-pty throw the actionable error if helper lookup/setup fails.
  }
};
