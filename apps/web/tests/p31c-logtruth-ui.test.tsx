import { describe, expect, it } from "vitest";
import { isAgentWorking } from "../src/app/canvas/agentActivity";
import { getTerminalRuntimeStateInfo } from "../src/app/terminalRuntimeStateStore";

const va = { type: "active-session", lifecycleState: "running", effectiveAgentProvider: "codex", agentRuntimeState: "held", heldActivity: false } as any;
describe("P31c log-truth drives map dots", () => {
  it("VaultAgent held + log-truth processing -> dots", () => expect(isAgentWorking({ ...va, logState: "processing" })).toBe(true));
  it("log-truth idle -> no dots even if legacy says processing", () => expect(isAgentWorking({ ...va, agentRuntimeState: "processing", logState: "idle" })).toBe(false));
  it("unknown falls back to legacy", () => {
    expect(isAgentWorking({ ...va, logState: "unknown" })).toBe(false);
    expect(isAgentWorking({ ...va, heldActivity: true, logState: "unknown" })).toBe(true);
  });
  it("not running -> no dots", () => expect(isAgentWorking({ ...va, lifecycleState: "exited", logState: "processing" })).toBe(false));
  it("flag off (ui:false) drops logState", () => {
    const lt = { mode: "shadow", logState: "processing", stateSource: "log", stateAgeSec: 1, legacyState: "held" };
    expect(getTerminalRuntimeStateInfo({ agentRuntimeState: "held", logTruth: { ...lt, ui: false } } as any)?.logState).toBeUndefined();
    expect(getTerminalRuntimeStateInfo({ agentRuntimeState: "held", logTruth: lt } as any)?.logState).toBe("processing");
  });
});
