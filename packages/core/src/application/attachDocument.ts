/**
 * Attach-document adapter — pure domain for the #45 W-ORCH-NATIVE Phase 3 [D9] chat "attach a
 * document to a conversation" parity (the retiring :3001 dashboard Chat's `POST /:id/upload`).
 *
 * Decision doc §8 [D9] + fleet/CHAT-PARITY.md: "Write the upload into the tentacle's worktree
 * workspace." The legacy engine read the uploaded file's text, converted it to markdown, and
 * APPENDED it as a user conversation message so the agent could consume it. octogent tentacles ARE
 * Claude Code sessions with a workspace they can Read from, so the octogent-native form is to
 * persist the upload into the tentacle's workspace.
 *
 * This module is the framework-agnostic contract for the piece that must be validated + sanitized
 * BEFORE any write: the filename (path-traversal safe basename) + the text content + a size cap
 * (legacy 10 MB, text only — legacy also read the file as `.text()`). It performs NO I/O; the write
 * + the conversation linkage live in apps/api (`runtime.attachDocumentToConversation`).
 *
 * ⚠️ Parity caveat (why the chat-parity row stays UNPROVEN): octogent has no per-conversation
 * document store. For the DEFAULT shared conversation the tentacle "workspace" is the whole repo
 * root, so an attachment lands in an ad-hoc `.octogent/attachments/<sessionId>/` subdir rather than
 * a managed store, and nothing DELIVERS the document into the live agent's context the way the
 * legacy message-append did. This contract + its runtime write are the REAL, honest groundwork;
 * the disposition flip waits on a genuine document store + ingestion path. See fleet/CHAT-PARITY.md.
 */

/** Max attachment size — matches the legacy upload cap (10 MB, text only). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type AttachDocumentInput = {
  filename?: unknown;
  /** The document's text content (legacy read the upload via `.text()` — text only). */
  content?: unknown;
};

export type NormalizedAttachment = {
  /** Path-traversal-safe basename to write under the conversation's attachments dir. */
  safeFilename: string;
  content: string;
  byteLength: number;
};

export class AttachDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachDocumentError";
  }
}

/**
 * Reduce an arbitrary filename to a safe basename: drop any directory components (both `/` and
 * `\`), strip control characters, and reject empty / dot-only / traversal names. Throws
 * AttachDocumentError when nothing safe remains.
 */
export const sanitizeAttachmentFilename = (filename: unknown): string => {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new AttachDocumentError("filename is required");
  }

  // Basename only — discard any path the caller supplied (traversal defense).
  const base = (filename.split(/[\\/]/).pop() ?? "").trim();
  // Strip control characters (codepoint <= 31) without a control-char regex.
  const cleaned = [...base].filter((char) => (char.codePointAt(0) ?? 0) > 31).join("");

  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    throw new AttachDocumentError("filename is invalid");
  }

  return cleaned;
};

/**
 * Validate + normalize an attach-document request: sanitize the filename, require string content,
 * and enforce the size cap. Throws AttachDocumentError (parity with the legacy 400 / 413 shapes).
 */
export const buildDocumentAttachment = (input: AttachDocumentInput): NormalizedAttachment => {
  const safeFilename = sanitizeAttachmentFilename(input.filename);

  if (typeof input.content !== "string") {
    throw new AttachDocumentError("content is required");
  }

  const byteLength = new TextEncoder().encode(input.content).length;
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachDocumentError("file too large");
  }

  return { safeFilename, content: input.content, byteLength };
};
