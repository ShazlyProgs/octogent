import { describe, expect, it } from "vitest";

import { buildConversationSummaryText } from "../src/application/conversationSummary";

describe("conversation-summary adapter (#45 Phase 3 [D9] chat 'summarize' — deterministic, no LLM)", () => {
  it("reports an empty conversation with no turns", () => {
    expect(
      buildConversationSummaryText({
        turnCount: 0,
        userTurnCount: 0,
        assistantTurnCount: 0,
        firstUserTurnPreview: null,
        lastUserTurnPreview: null,
        lastAssistantTurnPreview: null,
      }),
    ).toBe("No messages in this conversation yet.");
  });

  it("summarizes counts + first/last previews deterministically", () => {
    const summary = buildConversationSummaryText({
      turnCount: 4,
      userTurnCount: 2,
      assistantTurnCount: 2,
      firstUserTurnPreview: "draft the launch note",
      lastUserTurnPreview: "add the pricing table",
      lastAssistantTurnPreview: "done — pricing table added",
    });
    expect(summary).toContain("4 messages — 2 from the user, 2 from the assistant.");
    expect(summary).toContain('Opened with: "draft the launch note".');
    expect(summary).toContain('Latest from the user: "add the pricing table".');
    expect(summary).toContain('Latest reply: "done — pricing table added".');
  });

  it("does not repeat the opener as the latest user turn when they are identical", () => {
    const summary = buildConversationSummaryText({
      turnCount: 2,
      userTurnCount: 1,
      assistantTurnCount: 1,
      firstUserTurnPreview: "summarize the deck",
      lastUserTurnPreview: "summarize the deck",
      lastAssistantTurnPreview: "here is the summary",
    });
    // The single-message case reads "1 message"; the opener line appears once, not twice.
    expect(summary).toContain("2 messages — 1 from the user, 1 from the assistant.");
    expect(summary.match(/Opened with:/g)?.length).toBe(1);
    expect(summary).not.toContain("Latest from the user:");
  });

  it("uses the singular 'message' for a single turn", () => {
    const summary = buildConversationSummaryText({
      turnCount: 1,
      userTurnCount: 1,
      assistantTurnCount: 0,
      firstUserTurnPreview: "hello there",
      lastUserTurnPreview: "hello there",
      lastAssistantTurnPreview: null,
    });
    expect(summary).toContain("1 message — 1 from the user, 0 from the assistant.");
  });
});
