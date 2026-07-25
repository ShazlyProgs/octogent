import { describe, expect, it } from "vitest";

import { createTerminalSanitizer, stripScrollbackErase } from "../src/components/terminalOutput";

const ESC = "\x1b";
const BEL = "\x07";
const ERASE = `${ESC}[3J`;

// Feed every chunk of a multi-chunk stream through one sanitizer instance, in
// order, joining the per-chunk return values — mirrors how Terminal.tsx drives
// it across WebSocket messages.
const stream = (sanitizer: ReturnType<typeof createTerminalSanitizer>, chunks: string[]) =>
  chunks.map((chunk) => sanitizer.sanitize(chunk)).join("");

describe("createTerminalSanitizer — ESC[3J stripped across chunk boundaries (D1)", () => {
  // 4 bytes => 5 split points (0..4). The load-bearing evidence: a ESC[3J split
  // between two PTY/WebSocket messages must still vanish, leaving surrounding text.
  it.each([
    ["before ESC (whole in chunk b)", 0],
    ["after ESC", 1],
    ["after [", 2],
    ["after 3", 3],
    ["after J (whole in chunk a)", 4],
  ])("strips ESC[3J split %s", (_label, split) => {
    const prefix = "AAA";
    const suffix = "BBB";
    const full = `${prefix}${ERASE}${suffix}`;
    const cutAt = prefix.length + split;
    const sanitizer = createTerminalSanitizer();

    const out = stream(sanitizer, [full.slice(0, cutAt), full.slice(cutAt)]);

    expect(out).toBe(`${prefix}${suffix}`);
  });

  it("strips multiple ESC[3J across many small chunks", () => {
    const sanitizer = createTerminalSanitizer();
    // Each byte of each sequence lands in its own chunk.
    const bytes = `x${ERASE}y${ERASE}z`.split("");
    expect(stream(sanitizer, bytes)).toBe("xyz");
  });

  it("passes a non-3J CSI (ESC[2J) through unchanged, even split after ESC[", () => {
    const sanitizer = createTerminalSanitizer();
    expect(stream(sanitizer, [`x${ESC}[`, "2Jy"])).toBe(`x${ESC}[2Jy`);
  });

  it("does not strip a private-mode ESC[?3J (only the public sequence is targeted)", () => {
    const sanitizer = createTerminalSanitizer();
    expect(stream(sanitizer, [`${ESC}[?3J`])).toBe(`${ESC}[?3J`);
  });

  it("holds back an incomplete ESC[3 prefix and emits it on flush (never drops tail)", () => {
    const sanitizer = createTerminalSanitizer();
    expect(sanitizer.sanitize(ERASE.slice(0, -1))).toBe(""); // "\x1b[3" held
    expect(sanitizer.flush()).toBe(`${ESC}[3`);
    // After flush the scanner is back in Ground; a standalone BEL passes through.
    expect(sanitizer.sanitize(BEL)).toBe(BEL);
  });

  it("flush emits a lone held ESC introducer", () => {
    const sanitizer = createTerminalSanitizer();
    expect(sanitizer.sanitize(ESC)).toBe("");
    expect(sanitizer.flush()).toBe(ESC);
  });

  it("flush is a no-op once nothing is held", () => {
    const sanitizer = createTerminalSanitizer();
    expect(sanitizer.sanitize("plain text")).toBe("plain text");
    expect(sanitizer.flush()).toBe("");
  });
});

describe("createTerminalSanitizer — OSC title sequences swallowed boundary-safe (D2)", () => {
  it("swallows an OSC sequence terminated by BEL in one chunk (no fragment, no bell)", () => {
    const sanitizer = createTerminalSanitizer();
    expect(sanitizer.sanitize(`${ESC}]0;title${BEL}`)).toBe("");
  });

  it("swallows an OSC split before its BEL terminator across chunks", () => {
    const sanitizer = createTerminalSanitizer();
    expect(stream(sanitizer, [`${ESC}]0;title`, `${BEL}after`])).toBe("after");
  });

  it("swallows a long OSC payload whose BEL lands in a later chunk", () => {
    const sanitizer = createTerminalSanitizer();
    const title = "X".repeat(200);
    expect(stream(sanitizer, [`${ESC}]2;${title}`, `more${BEL}done`])).toBe("done");
  });

  it("swallows an OSC terminated by ST (ESC \\)", () => {
    const sanitizer = createTerminalSanitizer();
    expect(stream(sanitizer, [`${ESC}]2;win${ESC}\\tail`])).toBe("tail");
  });

  it("swallows an OSC whose ST terminator (ESC \\) is split across chunks", () => {
    const sanitizer = createTerminalSanitizer();
    expect(stream(sanitizer, [`${ESC}]2;win${ESC}`, "\\tail"])).toBe("tail");
  });

  it("does not globally mute the bell: a standalone BEL passes through", () => {
    const sanitizer = createTerminalSanitizer();
    expect(sanitizer.sanitize(`a${BEL}b`)).toBe(`a${BEL}b`);
  });

  it("passes a standalone BEL through even when it opens a new chunk", () => {
    const sanitizer = createTerminalSanitizer();
    expect(stream(sanitizer, ["a", `${BEL}b`])).toBe(`a${BEL}b`);
  });

  it("swallows hundreds of OSC title sets without leaking a single BEL", () => {
    const sanitizer = createTerminalSanitizer();
    expect(sanitizer.sanitize(`${ESC}]0;t${BEL}`.repeat(500))).toBe("");
  });
});

describe("createTerminalSanitizer — mixed realistic stream", () => {
  it("handles text + OSC title + ESC[3J + text across two chunks", () => {
    const sanitizer = createTerminalSanitizer();
    const out = stream(sanitizer, [`line1\n${ESC}]0;My Title${BEL}\n`, `${ERASE}line2`]);
    expect(out).toBe("line1\n\nline2");
  });

  it("passes an ordinary 2-byte escape (ESC c reset) through unchanged, split-safe", () => {
    const sanitizer = createTerminalSanitizer();
    expect(stream(sanitizer, [`${ESC}`, "c"])).toBe(`${ESC}c`);
  });
});

describe("stripScrollbackErase (pure one-shot, kept for compatibility)", () => {
  it("strips every ESC[3J from a complete joined string in one call", () => {
    expect(stripScrollbackErase(`a${ERASE}b${ERASE}c`)).toBe("abc");
  });

  it("leaves other content untouched", () => {
    expect(stripScrollbackErase(`${ESC}[2Jhello`)).toBe(`${ESC}[2Jhello`);
  });
});
