import { describe, expect, it } from "vitest";

import { stripTerminalMouseReports } from "../src/components/terminalInput";

describe("stripTerminalMouseReports", () => {
  it.each([
    ["default mouse report", "\u001b[M !!"],
    ["SGR mouse press report", "\u001b[<0;12;8M"],
    ["SGR mouse release report", "\u001b[<0;12;8m"],
    ["SGR pixel mouse report", "\u001b[<32;1024;768M"],
  ])("removes a %s", (_label, report) => {
    expect(stripTerminalMouseReports(report)).toBe("");
  });

  it("removes mouse reports without dropping adjacent keyboard input", () => {
    expect(stripTerminalMouseReports("hello\u001b[<35;12;8M world")).toBe("hello world");
  });

  it.each(["hello", "\r", "\u001b[A", "\u001b[200~pasted text\u001b[201~"])(
    "preserves normal terminal input %j",
    (input) => {
      expect(stripTerminalMouseReports(input)).toBe(input);
    },
  );

  it.each([
    ["SGR wheel up", "\u001b[<64;12;8M"],
    ["SGR wheel down", "\u001b[<65;12;8M"],
    ["SGR wheel left", "\u001b[<66;12;8M"],
    ["SGR wheel right", "\u001b[<67;12;8M"],
    ["SGR wheel up with shift", "\u001b[<68;12;8M"],
    ["SGR wheel up with ctrl", "\u001b[<80;12;8M"],
  ])("preserves a %s report so alternate-screen apps can scroll their transcript", (_l, report) => {
    expect(stripTerminalMouseReports(report)).toBe(report);
  });

  it("still strips click reports adjacent to preserved wheel reports", () => {
    expect(stripTerminalMouseReports("\u001b[<0;1;1M\u001b[<64;12;8M\u001b[<0;1;1m")).toBe(
      "\u001b[<64;12;8M",
    );
  });
});
