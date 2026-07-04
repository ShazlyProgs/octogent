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
 * BEFORE any write: the filename (path-traversal safe basename + a text-only extension limit) +
 * the text content + a size cap (legacy 10 MB, text only — legacy also read the file as `.text()`).
 * It performs NO I/O; the write, the per-conversation document store, and the live-agent delivery
 * live in apps/api (`runtime.attachDocumentToConversation`).
 *
 * ✅ Parity closed (Phase 3 m8, MASTER-LIST r92): the two honest gaps the m7 groundwork flagged are
 * now met. (a) A managed PER-CONVERSATION document store keyed by conversation identity under
 * `.octogent/state/documents/<sessionId>/` (survives across turns, enumerable, path-traversal-safe)
 * replaces the ad-hoc repo-root dump. (b) The upload is DELIVERED into the live agent's context via
 * the proven send-message PTY primitive: `buildAttachmentDeliveryTurn` composes a user turn that
 * references the stored absolute path, submitted so the tentacle (which IS Claude Code, [D8]) Reads
 * it natively — the octogent-native form of the legacy message-append. See fleet/CHAT-PARITY.md.
 */

/** Max attachment size — matches the legacy upload cap (10 MB, text only). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Binary / non-text extensions rejected by the store. The store is text-only (legacy read every
 * upload via `.text()`), and the tentacle consumes an attachment by `Read`-ing the stored file, so
 * a binary blob would only ever surface as garbage text. Rejecting these up front is the honest
 * "extension limit" — everything else (all text/code/data types, incl. extension-less files) is
 * accepted, preserving the legacy upload's permissive text handling. Compared lowercase, no dot.
 */
export const ATTACHMENT_BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "o",
  "obj",
  "a",
  "lib",
  "node",
  "wasm",
  "class",
  "jar",
  "war",
  "zip",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "xz",
  "7z",
  "rar",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "tiff",
  "mp3",
  "mp4",
  "avi",
  "mov",
  "wav",
  "flac",
  "mkv",
  "webm",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "dmg",
  "iso",
  "img",
  "pyc",
]);

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

/** Lowercase extension of a (already-sanitized) basename, or "" when it has none. */
const extensionOf = (safeFilename: string): string => {
  const dot = safeFilename.lastIndexOf(".");
  // No dot, leading-dot dotfile (".env"), or trailing dot → treat as extension-less.
  if (dot <= 0 || dot === safeFilename.length - 1) {
    return "";
  }
  return safeFilename.slice(dot + 1).toLowerCase();
};

/**
 * Reject a blocked (binary / non-text) extension. Throws AttachDocumentError("unsupported file
 * type"). Extension-less files pass (legacy treated unknown uploads as plain text).
 */
export const assertAllowedAttachmentExtension = (safeFilename: string): void => {
  const ext = extensionOf(safeFilename);
  if (ext.length > 0 && ATTACHMENT_BLOCKED_EXTENSIONS.has(ext)) {
    throw new AttachDocumentError("unsupported file type");
  }
};

/**
 * Validate + normalize an attach-document request: sanitize the filename, enforce the text-only
 * extension limit, require string content, and enforce the size cap. Throws AttachDocumentError
 * (parity with the legacy 400 / 413 shapes).
 */
export const buildDocumentAttachment = (input: AttachDocumentInput): NormalizedAttachment => {
  const safeFilename = sanitizeAttachmentFilename(input.filename);
  assertAllowedAttachmentExtension(safeFilename);

  if (typeof input.content !== "string") {
    throw new AttachDocumentError("content is required");
  }

  const byteLength = new TextEncoder().encode(input.content).length;
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachDocumentError("file too large");
  }

  return { safeFilename, content: input.content, byteLength };
};

/**
 * Compose the user turn that DELIVERS a stored attachment into the live tentacle session. The
 * tentacle IS Claude Code ([D8]) with native filesystem access, so parity with the legacy
 * message-append is achieved not by inlining the content but by referencing the stored absolute
 * path and instructing the agent to Read it. Pure — the runtime wraps this in the bracketed-paste
 * PTY submit (via `buildConversationInputSubmit`) and hands it to the session.
 */
export const buildAttachmentDeliveryTurn = (filename: string, absolutePath: string): string =>
  `A document "${filename}" was attached to this conversation. ` +
  `Read it with your Read tool from this path when relevant:\n${absolutePath}`;
