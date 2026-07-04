import { describe, expect, it } from "vitest";

import {
  AttachDocumentError,
  MAX_ATTACHMENT_BYTES,
  buildAttachmentDeliveryTurn,
  buildDocumentAttachment,
  sanitizeAttachmentFilename,
} from "../src/application/attachDocument";

describe("attach-document adapter (#45 Phase 3 [D9] chat 'attach a document')", () => {
  describe("sanitizeAttachmentFilename — path-traversal-safe basename", () => {
    it("requires a non-empty string filename", () => {
      expect(() => sanitizeAttachmentFilename(undefined)).toThrow(AttachDocumentError);
      expect(() => sanitizeAttachmentFilename("")).toThrow(AttachDocumentError);
      expect(() => sanitizeAttachmentFilename("   ")).toThrow(AttachDocumentError);
      expect(() => sanitizeAttachmentFilename(undefined)).toThrow("filename is required");
    });

    it("keeps a plain filename", () => {
      expect(sanitizeAttachmentFilename("notes.md")).toBe("notes.md");
    });

    it("drops directory components + traversal (keeps only the basename)", () => {
      expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("passwd");
      expect(sanitizeAttachmentFilename("C:\\Users\\shazl\\secret.txt")).toBe("secret.txt");
      expect(sanitizeAttachmentFilename("a/b/c/report.csv")).toBe("report.csv");
    });

    it("rejects a dot-only / traversal-only name", () => {
      expect(() => sanitizeAttachmentFilename("..")).toThrow(AttachDocumentError);
      expect(() => sanitizeAttachmentFilename("../..")).toThrow(AttachDocumentError);
      expect(() => sanitizeAttachmentFilename(".")).toThrow(AttachDocumentError);
    });
  });

  describe("buildDocumentAttachment — content + size validation", () => {
    it("requires string content", () => {
      expect(() => buildDocumentAttachment({ filename: "notes.md" })).toThrow(
        "content is required",
      );
      expect(() => buildDocumentAttachment({ filename: "notes.md", content: 42 })).toThrow(
        AttachDocumentError,
      );
    });

    it("normalizes a valid attachment with its byte length", () => {
      const attachment = buildDocumentAttachment({
        filename: "../notes.md",
        content: "# Launch plan\n\nShip it.",
      });
      expect(attachment.safeFilename).toBe("notes.md");
      expect(attachment.content).toBe("# Launch plan\n\nShip it.");
      expect(attachment.byteLength).toBe(new TextEncoder().encode(attachment.content).length);
    });

    it("rejects content over the size cap (legacy 413)", () => {
      const oversized = "x".repeat(MAX_ATTACHMENT_BYTES + 1);
      expect(() => buildDocumentAttachment({ filename: "big.txt", content: oversized })).toThrow(
        "file too large",
      );
    });

    it("accepts text / code / data extensions and extension-less files (legacy-permissive)", () => {
      for (const filename of ["notes.md", "data.csv", "config.yaml", "app.ts", "log", "README"]) {
        expect(buildDocumentAttachment({ filename, content: "ok" }).safeFilename).toBe(
          filename.split(/[\\/]/).pop(),
        );
      }
    });

    it("rejects binary / non-text extensions with the store's extension limit", () => {
      for (const filename of [
        "photo.png",
        "archive.zip",
        "installer.exe",
        "report.pdf",
        "lib.dll",
      ]) {
        expect(() => buildDocumentAttachment({ filename, content: "x" })).toThrow(
          "unsupported file type",
        );
      }
    });
  });

  describe("buildAttachmentDeliveryTurn — the live-agent reference turn", () => {
    it("references the filename + the absolute stored path so the tentacle can Read it", () => {
      const absolutePath = "/srv/.octogent/state/documents/terminal-1/launch-notes.md";
      const turn = buildAttachmentDeliveryTurn("launch-notes.md", absolutePath);
      expect(turn).toContain("launch-notes.md");
      expect(turn).toContain(absolutePath);
      // Instructs a native Read (the [D8] pattern), not an inlined blob.
      expect(turn).toMatch(/Read/);
    });
  });
});
