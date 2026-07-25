import { describe, expect, it, vi } from "vitest";

import { createTerminalWriteCoalescer } from "../src/components/terminalFlush";

const createFlushTrigger = () => {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const requestFlush = vi.fn((flush: () => void) => {
    const handle = nextHandle++;
    callbacks.set(handle, flush);
    return handle;
  });
  const cancelFlush = vi.fn((handle: number) => {
    callbacks.delete(handle);
  });

  return {
    requestFlush,
    cancelFlush,
    fire() {
      const pendingCallbacks = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pendingCallbacks) {
        callback();
      }
    },
  };
};

describe("createTerminalWriteCoalescer", () => {
  it("preserves FIFO order and LF line endings in one flush", () => {
    const write = vi.fn();
    const trigger = createFlushTrigger();
    const coalescer = createTerminalWriteCoalescer({ write, ...trigger });

    coalescer.push("alpha\n");
    coalescer.push("beta");
    coalescer.push("\ngamma\n");

    expect(trigger.requestFlush).toHaveBeenCalledTimes(1);
    expect(coalescer.flush()).toBe("alpha\nbeta\ngamma\n");
    expect(write).toHaveBeenCalledWith("alpha\nbeta\ngamma\n");
  });

  it("returns nothing for an empty buffer and does not call through", () => {
    const write = vi.fn();
    const trigger = createFlushTrigger();
    const coalescer = createTerminalWriteCoalescer({ write, ...trigger });

    expect(coalescer.flush()).toBeUndefined();
    expect(trigger.requestFlush).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("turns many messages into one scheduled write without losing data", () => {
    const write = vi.fn();
    const trigger = createFlushTrigger();
    const coalescer = createTerminalWriteCoalescer({ write, ...trigger });
    const chunks = Array.from({ length: 1_000 }, (_, index) => `chunk-${index};`);

    for (const chunk of chunks) {
      coalescer.push(chunk);
    }

    expect(trigger.requestFlush).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();

    trigger.fire();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(chunks.join(""));
  });

  it("flushes a pending burst synchronously during teardown without data loss", () => {
    const write = vi.fn();
    const trigger = createFlushTrigger();
    const coalescer = createTerminalWriteCoalescer({ write, ...trigger });

    coalescer.push("pending ");
    coalescer.push("output\n");

    expect(coalescer.flush()).toBe("pending output\n");
    expect(trigger.cancelFlush).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("pending output\n");

    trigger.fire();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("requests a new flush after the previous burst was drained", () => {
    const write = vi.fn();
    const trigger = createFlushTrigger();
    const coalescer = createTerminalWriteCoalescer({ write, ...trigger });

    coalescer.push("first");
    trigger.fire();
    coalescer.push("second");

    expect(trigger.requestFlush).toHaveBeenCalledTimes(2);
    trigger.fire();
    expect(write).toHaveBeenNthCalledWith(1, "first");
    expect(write).toHaveBeenNthCalledWith(2, "second");
  });
});
