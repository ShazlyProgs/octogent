import type { GraphNode } from "./types";
// P31: one rule for Hide Idle. Log truth wins when present; otherwise non-running seats are idle.
export const isIdleForHide = (n: Pick<GraphNode, "type" | "logState" | "lifecycleState" | "agentState" | "hasUserPrompt">): boolean => {
  if (n.type === "inactive-session") return true;
  if (n.type !== "active-session") return false;
  if (n.logState) return n.logState === "idle";
  if (n.lifecycleState && n.lifecycleState !== "running") return true;
  return n.agentState === "idle" || n.hasUserPrompt === false;
};
