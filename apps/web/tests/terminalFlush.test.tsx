import { describe, expect, it, vi } from "vitest";

import { createTerminalWriteCoalescer } from "../src/components/terminalFlush";

const createMockTerminal = () => ({
  write: vi.fn((_: string, _callback?: () => void) => {}),
});

// A controllable requestAnimationFrame stub: scheduled callbacks sit in a queue
// until `fire()` drains them, so a test can enqueue a synchronous burst (the
// freeze scenario) and assert nothing writes until the frame is released.
const createRafStub = () => {
  let nextHandle = 1;
  const queue = new Map<number, FrameRequestCallback>();
  const cancelled = new Set<number>();
  const schedule = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    queue.set(handle, callback);
    return handle;
  });
  const cancel = vi.fn((handle: number) => {
    queue.delete(handle);
    cancelled.add(handle);
  });
  return {
    schedule,
    cancel,
    pendingCount: () => queue.size,
    cancelledCount: () => cancelled.size,
    fire() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    },
  };
};

describe("createTerminalWriteCoalescer", () => {
  it("writes a single enqueued chunk once the frame fires", () => {
    const terminal = createMockTerminal();
    const raf = createRafStub();
    const coalescer = createTerminalWriteCoalescer(terminal, raf.schedule, raf.cancel);

    coalescer.enqueue("hello");

    // Buffered until the frame — main thread is not blocked by a write.
    expect(raf.schedule).toHaveBeenCalledTimes(1);
    expect(terminal.write).not.toHaveBeenCalled();

    raf.fire();

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith("hello");
  });

  it("coalesces a burst of chunks into one terminal.write per frame, preserving order", () => {
    const terminal = createMockTerminal();
    const raf = createRafStub();
    const coalescer = createTerminalWriteCoalescer(terminal, raf.schedule, raf.cancel);

    // Burst flood: many chunks arrive synchronously before the frame fires.
    // This is exactly claude's token-by-token stream that froze the UI when each
    // chunk triggered its own JSON.parse + terminal.write.
    const count = 1000;
    for (let i = 0; i < count; i++) {
      coalescer.enqueue(`chunk-${i};`);
    }

    // One frame scheduled for the whole burst, zero writes — the main thread is
    // freed from per-message overhead no matter how large the flood.
    expect(raf.schedule).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);
    expect(terminal.write).not.toHaveBeenCalled();

    raf.fire();

    // Exactly one write, every chunk present and in arrival order.
    expect(terminal.write).toHaveBeenCalledTimes(1);
    const [firstCall] = terminal.write.mock.calls;
    const written = firstCall?.[0] ?? "";
    const chunks = written.split(";").filter(Boolean);
    expect(chunks).toHaveLength(count);
    expect(chunks[0]).toBe("chunk-0");
    expect(chunks[count - 1]).toBe(`chunk-${count - 1}`);
    expect(raf.pendingCount()).toBe(0);
  });

  it("schedules a fresh frame for a burst that arrives after the previous flush", () => {
    const terminal = createMockTerminal();
    const raf = createRafStub();
    const coalescer = createTerminalWriteCoalescer(terminal, raf.schedule, raf.cancel);

    coalescer.enqueue("a");
    raf.fire();
    expect(terminal.write).toHaveBeenCalledTimes(1);

    coalescer.enqueue("b");
    coalescer.enqueue("c");

    expect(raf.schedule).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenCalledTimes(1);

    raf.fire();

    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenLastCalledWith("bc");
  });

  it("dispose cancels the pending frame and discards buffered chunks without writing", () => {
    const terminal = createMockTerminal();
    const raf = createRafStub();
    const coalescer = createTerminalWriteCoalescer(terminal, raf.schedule, raf.cancel);

    coalescer.enqueue("pending");
    expect(raf.pendingCount()).toBe(1);

    coalescer.dispose();

    expect(raf.cancel).toHaveBeenCalledTimes(1);
    expect(terminal.write).not.toHaveBeenCalled();

    // Even if the frame were somehow released, a disposed coalescer writes nothing.
    raf.fire();
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("ignores enqueues after dispose so a torn-down terminal is never written to", () => {
    const terminal = createMockTerminal();
    const raf = createRafStub();
    const coalescer = createTerminalWriteCoalescer(terminal, raf.schedule, raf.cancel);

    coalescer.dispose();
    coalescer.enqueue("late");

    expect(raf.schedule).not.toHaveBeenCalled();
    raf.fire();
    expect(terminal.write).not.toHaveBeenCalled();
  });
});
