import { describe, expect, it } from "vitest";

import {
  MAX_DERIVED_TITLE_LENGTH,
  deriveConversationTitle,
  resolveConversationTitle,
} from "../src/application/conversationTitle";

describe("conversation-title adapter (#45 Phase 3 [D9] chat 'generate a title' — auto-title fold)", () => {
  describe("deriveConversationTitle — deterministic auto-title from the first user turn", () => {
    it("returns null when there is no first turn", () => {
      expect(deriveConversationTitle(null)).toBeNull();
    });

    it("returns null for a first turn shorter than the length gate (legacy >=10)", () => {
      expect(deriveConversationTitle("hi")).toBeNull();
      expect(deriveConversationTitle("   ok   ")).toBeNull();
    });

    it("uses the first user turn verbatim when short enough (whitespace-normalized)", () => {
      expect(deriveConversationTitle("draft the launch note")).toBe("draft the launch note");
      expect(deriveConversationTitle("  build   export  ")).toBe("build export");
    });

    it("uses only the first line of a multi-line first turn (legacy first-line cut)", () => {
      expect(deriveConversationTitle("summarize the deck\nand attach the pdf")).toBe(
        "summarize the deck",
      );
    });

    it("truncates a long first turn with a trailing ellipsis at MAX_DERIVED_TITLE_LENGTH", () => {
      const long = "plan ".repeat(40); // well over the cap
      const derived = deriveConversationTitle(long);
      expect(derived).not.toBeNull();
      expect(derived?.length).toBe(MAX_DERIVED_TITLE_LENGTH);
      expect(derived?.endsWith("…")).toBe(true);
    });
  });

  describe("resolveConversationTitle — stored title wins, else derived, else null", () => {
    it("returns the explicitly stored title over the derivable one", () => {
      expect(
        resolveConversationTitle({
          storedTitle: "Launch planning",
          firstUserTurnPreview: "draft the launch note",
        }),
      ).toBe("Launch planning");
    });

    it("falls back to the derived auto-title when no title is stored", () => {
      expect(
        resolveConversationTitle({
          storedTitle: null,
          firstUserTurnPreview: "draft the launch note",
        }),
      ).toBe("draft the launch note");
    });

    it("ignores a blank stored title and derives instead", () => {
      expect(
        resolveConversationTitle({
          storedTitle: "   ",
          firstUserTurnPreview: "draft the launch note",
        }),
      ).toBe("draft the launch note");
    });

    it("is null when nothing is stored and nothing is derivable", () => {
      expect(
        resolveConversationTitle({ storedTitle: null, firstUserTurnPreview: null }),
      ).toBeNull();
      expect(
        resolveConversationTitle({ storedTitle: null, firstUserTurnPreview: "hi" }),
      ).toBeNull();
    });
  });
});
