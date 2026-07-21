// PROBE: drive a REAL xterm.js 5.3.0 in jsdom to establish empirical facts for
// defect #1 (selection under mouse tracking) and defect #2 (ArrowUp encoding).
// Not a regression test of app code — a behavioral probe of the library.
//
// xterm's Color.ts caches a 2d context at MODULE INIT and calls
// createLinearGradient on it. setup.ts's canvas stub lacks that method, so we
// install a richer Proxy stub BEFORE dynamically importing xterm (static
// imports are hoisted above the stub).
import { afterEach, describe, expect, it } from "vitest";

const installRichCanvasStub = () => {
  // ScreenDprMonitor calls window.matchMedia, which jsdom lacks.
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    })) as unknown as typeof window.matchMedia;
  }
  const ctx = new Proxy(
    { canvas: {}, imageSmoothingEnabled: true },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        if (prop === "createLinearGradient" || prop === "createRadialGradient")
          return () => ({ addColorStop() {} });
        if (prop === "createPattern") return () => ({});
        if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) });
        if (prop === "measureText") return () => ({ width: 8 });
        return () => {};
      },
      set: () => true,
    },
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ctx,
  });
};

const fixRect = (el: HTMLElement) => {
  Object.defineProperty(el, "clientWidth", { value: 480, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 240, configurable: true });
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 480,
      bottom: 240,
      width: 480,
      height: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
};

const openTerminal = async () => {
  installRichCanvasStub();
  const { Terminal } = await import("xterm");
  const host = document.createElement("div");
  document.body.appendChild(host);
  fixRect(host);
  const term = new Terminal({ cols: 40, rows: 10 });
  term.open(host);
  // xterm measures mouse→cell against its internal .xterm-screen (and other
  // sub-elements), which have zero rects in jsdom. Stub every descendant so
  // coordinate math returns finite cells.
  for (const el of host.querySelectorAll("*")) {
    fixRect(el as HTMLElement);
  }
  return { term, host };
};

type XtermLike = {
  write: (d: string, cb?: () => void) => void;
  onData: (cb: (d: string) => void) => { dispose: () => void };
  dispose: () => void;
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
};

const flush = (term: XtermLike, data: string) =>
  new Promise<void>((resolve) => term.write(data, () => resolve()));

const fireKey = (term: XtermLike, key: string, keyCode: number) => {
  const textarea =
    term.textarea ??
    term.element?.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
  if (!textarea) throw new Error("no helper textarea");
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  // jsdom does not derive legacy keyCode from key; xterm reads keyCode.
  Object.defineProperty(ev, "keyCode", { value: keyCode });
  Object.defineProperty(ev, "which", { value: keyCode });
  textarea.dispatchEvent(ev);
};

const captureData = (term: XtermLike) => {
  let emitted = "";
  const sub = term.onData((d) => {
    emitted += d;
  });
  return {
    data: () => emitted,
    dispose: () => sub.dispose(),
  };
};

describe("xterm probe — mouse tracking", () => {
  let term: XtermLike;
  afterEach(() => term?.dispose());

  it("enables mouse events when claude's SGR any-event mode is written", async () => {
    ({ term } = await openTerminal());
    await flush(term, "\x1b[?1006h\x1b[?1003h");
    const coreMouse = term as unknown as {
      coreMouseService?: { areMouseEventsActive: boolean };
      _core?: { coreMouseService: { areMouseEventsActive: boolean } };
    };
    const active =
      coreMouse.coreMouseService?.areMouseEventsActive ??
      coreMouse._core?.coreMouseService.areMouseEventsActive;
    expect(active).toBe(true);
  });
});

describe("xterm probe — ArrowUp encoding (defect #2)", () => {
  let term: XtermLike;
  afterEach(() => term?.dispose());

  it("emits CSI ESC[A by default (normal cursor mode)", async () => {
    ({ term } = await openTerminal());
    const cap = captureData(term);
    fireKey(term, "ArrowUp", 38);
    expect(cap.data()).toContain("\x1b[A");
    cap.dispose();
  });

  it("emits SS3 ESCOA after DECCKM (\\x1b[?1h)", async () => {
    ({ term } = await openTerminal());
    await flush(term, "\x1b[?1h");
    const cap = captureData(term);
    fireKey(term, "ArrowUp", 38);
    expect(cap.data()).toContain("\x1bOA");
    cap.dispose();
  });
});

// NOTE: a selection-simulation probe (plain-drag vs shift-drag under tracking)
// was attempted but jsdom's synthetic mousedown does not reach xterm's internal
// mouse handlers (zero-layout + event-targeting artifacts), so it is unreliable.
// The selection mechanism is instead source-proven:
//   - xterm Terminal.ts:759 forwards a mouse report on mousedown only when
//     `areMouseEventsActive` is true AND shouldForceSelection(ev) is false.
//   - SelectionService.ts:429-435 shouldForceSelection returns shiftKey
//     (non-Mac), so Shift+drag forces local selection even under tracking.
