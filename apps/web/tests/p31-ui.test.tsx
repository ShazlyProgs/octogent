import { describe, expect, it } from "vitest";
import { horizontalWheelDelta } from "../src/app/canvas/wheelScroll";
import { isIdleForHide } from "../src/app/canvas/hideIdle";
import { PRIMARY_NAV_ITEMS } from "../src/app/constants";
import { parsePrimaryNavKey } from "../src/app/hotkeys";

describe("P31 wheel mapping", () => {
  it("maps deltaX and shift+wheel, leaves vertical wheel alone", () => {
    expect(horizontalWheelDelta({ deltaX: 30, deltaY: 2, shiftKey: false })).toBe(30);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 40, shiftKey: true })).toBe(40);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 40, shiftKey: false })).toBe(0);
    expect(horizontalWheelDelta({ deltaX: 3, deltaY: 1, shiftKey: false, deltaMode: 1 })).toBe(48);
  });
});
describe("P31 nav", () => {
  it("shows only four items and maps keys 1-4 in display order", () => {
    expect(PRIMARY_NAV_ITEMS.map((i) => i.label)).toEqual(["Agents", "Activity", "Code Intel", "Conversations"]);
    expect([1, 2, 3, 4].map((k) => parsePrimaryNavKey(String(k)))).toEqual([1, 3, 4, 5]);
    expect(parsePrimaryNavKey("5")).toBeNull();
  });
});
describe("P31 hide idle", () => {
  it("prefers log truth, then lifecycle, then legacy state", () => {
    expect(isIdleForHide({ type: "active-session", logState: "processing", agentState: "idle" })).toBe(false);
    expect(isIdleForHide({ type: "active-session", logState: "idle", agentState: "processing" as never })).toBe(true);
    expect(isIdleForHide({ type: "active-session", lifecycleState: "stale", agentState: "processing" as never })).toBe(true);
    expect(isIdleForHide({ type: "inactive-session" })).toBe(true);
    expect(isIdleForHide({ type: "tentacle" })).toBe(false);
  });
});
