import type { ApiRouteHandler } from "./routeHelpers";
import {
  readJsonBodyOrWriteError,
  writeJson,
  writeMethodNotAllowed,
  writeNoContent,
  writeText,
} from "./routeHelpers";

const CONVERSATION_SEARCH_PATH = "/api/conversations/search";
const CONVERSATION_ITEM_PATH_PATTERN = /^\/api\/conversations\/([^/]+)$/;
const CONVERSATION_EXPORT_PATH_PATTERN = /^\/api\/conversations\/([^/]+)\/export$/;
const CONVERSATION_MESSAGES_PATH_PATTERN = /^\/api\/conversations\/([^/]+)\/messages$/;
const CONVERSATION_TITLE_PATH_PATTERN = /^\/api\/conversations\/([^/]+)\/title$/;
const CONVERSATION_SUMMARIZE_PATH_PATTERN = /^\/api\/conversations\/([^/]+)\/summarize$/;

export const handleConversationsCollectionRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  if (requestUrl.pathname !== "/api/conversations") {
    return false;
  }

  if (request.method === "DELETE") {
    runtime.deleteAllConversationSessions();
    writeNoContent(response, 204, corsOrigin);
    return true;
  }

  // #45 Phase 3 [D9] — create-conversation adapter. Parity with the legacy dashboard Chat's
  // POST /: start a chat session bound to a tentacle terminal (a live Claude Code session, [D8]).
  // Returns 201 with the new conversation's session identity, or 400 for invalid input.
  if (request.method === "POST") {
    const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
    if (!bodyReadResult.ok) {
      return true;
    }

    const result = runtime.createConversation(bodyReadResult.payload);
    if (result.status === "invalid") {
      writeJson(response, 400, { error: result.error }, corsOrigin);
      return true;
    }

    writeJson(
      response,
      201,
      {
        sessionId: result.sessionId,
        tentacleId: result.tentacleId,
        tentacleName: result.tentacleName,
        workspaceMode: result.workspaceMode,
      },
      corsOrigin,
    );
    return true;
  }

  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const payload = runtime.listConversationSessions();
  writeJson(response, 200, payload, corsOrigin);
  return true;
};

export const handleConversationSearchRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  if (requestUrl.pathname !== CONVERSATION_SEARCH_PATH) {
    return false;
  }

  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const query = requestUrl.searchParams.get("q") ?? "";
  if (query.trim().length === 0) {
    writeJson(response, 400, { error: "Missing search query parameter 'q'." }, corsOrigin);
    return true;
  }

  const payload = runtime.searchConversations(query);
  writeJson(response, 200, payload, corsOrigin);
  return true;
};

// #45 Phase 3 [D9] — send-message KEYSTONE adapter. Parity with the legacy dashboard Chat's
// POST /:id/messages: submit a chat turn into the conversation's live tentacle session, with the
// per-conversation processing lock. The reply is surfaced by the native GET /api/conversations/:id
// (Claude Code's Stop hook writes the turns) — this route is the SUBMIT half, so it returns 202
// Accepted, not the assistant reply inline. See fleet/CHAT-PARITY.md.
export const handleConversationMessagesRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  const match = requestUrl.pathname.match(CONVERSATION_MESSAGES_PATH_PATTERN);
  if (!match) {
    return false;
  }

  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyReadResult.ok) {
    return true;
  }

  const sessionId = decodeURIComponent(match[1] ?? "");
  const body = bodyReadResult.payload as Record<string, unknown> | null;
  const content = body ? body.content : undefined;

  const result = runtime.submitConversationMessage(sessionId, content);

  if (result.status === "invalid-content") {
    writeJson(response, 400, { error: result.error }, corsOrigin);
    return true;
  }

  if (result.status === "no-session") {
    writeJson(response, 404, { error: "Conversation session not found." }, corsOrigin);
    return true;
  }

  if (result.status === "busy") {
    writeJson(
      response,
      409,
      { error: "Conversation is currently processing a message" },
      corsOrigin,
    );
    return true;
  }

  writeJson(
    response,
    202,
    {
      status: "accepted",
      sessionId,
      submitId: result.submitId,
      tentacleId: result.tentacleId,
      content: result.text,
    },
    corsOrigin,
  );
  return true;
};

// #45 Phase 3 [D9] — conversation-title adapter. Parity with the legacy dashboard Chat's
// generate-title + auto-title, folded into one octogent-native derive-and-pin (no LLM): derive a
// title from the first user turn and persist it in the metadata sidecar.
export const handleConversationTitleRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  const match = requestUrl.pathname.match(CONVERSATION_TITLE_PATH_PATTERN);
  if (!match) {
    return false;
  }

  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const sessionId = decodeURIComponent(match[1] ?? "");
  const result = runtime.generateConversationTitle(sessionId);

  if (result.status === "no-conversation") {
    writeJson(response, 404, { error: "Conversation session not found." }, corsOrigin);
    return true;
  }

  if (result.status === "no-title") {
    writeJson(response, 200, { sessionId: result.sessionId, title: null }, corsOrigin);
    return true;
  }

  writeJson(response, 200, { sessionId: result.sessionId, title: result.title }, corsOrigin);
  return true;
};

// #45 Phase 3 [D9] — conversation-summary adapter. Parity with the legacy dashboard Chat's
// POST /:id/summarize: a deterministic recap over the transcript's counts + previews (no LLM).
export const handleConversationSummarizeRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  const match = requestUrl.pathname.match(CONVERSATION_SUMMARIZE_PATH_PATTERN);
  if (!match) {
    return false;
  }

  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const sessionId = decodeURIComponent(match[1] ?? "");
  const result = runtime.summarizeConversation(sessionId);

  if (result.status === "no-conversation") {
    writeJson(response, 404, { error: "Conversation session not found." }, corsOrigin);
    return true;
  }

  writeJson(response, 200, { sessionId: result.sessionId, summary: result.summary }, corsOrigin);
  return true;
};

export const handleConversationItemRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  const match = requestUrl.pathname.match(CONVERSATION_ITEM_PATH_PATTERN);
  if (!match) {
    return false;
  }

  const sessionId = decodeURIComponent(match[1] ?? "");

  if (request.method === "DELETE") {
    runtime.deleteConversationSession(sessionId);
    writeNoContent(response, 204, corsOrigin);
    return true;
  }

  // #45 Phase 3 [D9] — rename-conversation adapter. Parity with the legacy dashboard Chat's
  // PUT /:id metadata update: persist a session title over the transcript store (no LLM).
  if (request.method === "PUT") {
    const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
    if (!bodyReadResult.ok) {
      return true;
    }

    const body = bodyReadResult.payload as Record<string, unknown> | null;
    const result = runtime.renameConversation(sessionId, body ? body.title : undefined);

    if (result.status === "invalid") {
      writeJson(response, 400, { error: result.error }, corsOrigin);
      return true;
    }

    if (result.status === "no-conversation") {
      writeJson(response, 404, { error: "Conversation session not found." }, corsOrigin);
      return true;
    }

    writeJson(response, 200, { sessionId: result.sessionId, title: result.title }, corsOrigin);
    return true;
  }

  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const payload = runtime.readConversationSession(sessionId);
  if (!payload) {
    writeJson(response, 404, { error: "Conversation session not found." }, corsOrigin);
    return true;
  }

  writeJson(response, 200, payload, corsOrigin);
  return true;
};

export const handleConversationExportRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime },
) => {
  const match = requestUrl.pathname.match(CONVERSATION_EXPORT_PATH_PATTERN);
  if (!match) {
    return false;
  }

  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const sessionId = decodeURIComponent(match[1] ?? "");
  const format = requestUrl.searchParams.get("format");
  if (format !== "json" && format !== "md") {
    writeJson(response, 400, { error: "Unsupported conversation export format." }, corsOrigin);
    return true;
  }

  if (format === "json") {
    const payload = runtime.readConversationSession(sessionId);
    if (!payload) {
      writeJson(response, 404, { error: "Conversation session not found." }, corsOrigin);
      return true;
    }

    writeJson(response, 200, payload, corsOrigin);
    return true;
  }

  const payload = runtime.exportConversationSession(sessionId, "md");
  if (payload === null) {
    writeJson(response, 404, { error: "Conversation session not found." }, corsOrigin);
    return true;
  }

  writeText(response, 200, payload, "text/markdown; charset=utf-8", corsOrigin);
  return true;
};
