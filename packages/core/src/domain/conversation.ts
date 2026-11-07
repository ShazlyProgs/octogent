export type ConversationTurn = {
  turnId: string;
  role: "user" | "assistant";
  content: string;
  startedAt: string;
  endedAt: string;
};

export type ConversationTranscriptEvent = {
  eventId: string;
  sessionId: string;
  tentacleId: string;
  timestamp: string;
  type: "session_start" | "input_submit" | "output_chunk" | "state_change" | "session_end";
};

export type ConversationSessionSummary = {
  sessionId: string;
  tentacleId: string | null;
  /** P31: current tentacle name and provider session/thread from the live registry. */
  tentacleName?: string | null;
  providerSessionId?: string | null;
  /** P31: number of provider sessions in this terminal's transcript; previews follow the latest. */
  providerSessionCount?: number;
  /**
   * The conversation's display title. Resolves to an explicitly stored title (set by the
   * rename-conversation / generate-title adapters, #45 Phase 3 [D9]) when present, otherwise a
   * title auto-derived from the first user turn, otherwise null. Persisted in a metadata sidecar
   * alongside the transcript — never LLM-generated.
   */
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  turnCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  firstUserTurnPreview: string | null;
  lastUserTurnPreview: string | null;
  lastAssistantTurnPreview: string | null;
};

export type ConversationSessionDetail = ConversationSessionSummary & {
  turns: ConversationTurn[];
  events: ConversationTranscriptEvent[];
};

export type ConversationSearchHit = {
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  snippet: string;
  turnStartedAt: string;
};

export type ConversationSearchResult = {
  query: string;
  hits: ConversationSearchHit[];
};
