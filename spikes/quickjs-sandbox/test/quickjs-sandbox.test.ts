import { describe, expect, it } from "vitest";
import { executeQuickJs } from "../src/quickjs-sandbox.ts";

const mib = 1024 * 1024;

describe("QuickJS denial boundaries", () => {
  it("interrupts a runaway loop without hanging the host", async () => {
    const startedAt = Date.now();
    const result = await executeQuickJs("while (true) {}", {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 25,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toMatchObject({
      error: { kind: "timeout", message: "interrupted" },
      memoryLimitExceeded: false,
      ok: false,
      timedOut: true,
    });
  });

  it("contains a memory bomb at the configured runtime cap", async () => {
    const result = await executeQuickJs(
      `
        const chunks = [];
        while (true) {
          chunks.push(new ArrayBuffer(256 * 1024));
        }
      `,
      {
        memoryLimitBytes: 2 * mib,
        timeoutMs: 2_000,
      }
    );

    expect(result).toMatchObject({
      error: {
        kind: "memory-limit",
        message: expect.stringMatching(/out of memory/i),
      },
      memoryLimitExceeded: true,
      ok: false,
      timedOut: false,
    });

    const healthyFollowUp = await executeQuickJs("21 * 2", {
      memoryLimitBytes: 2 * mib,
      timeoutMs: 100,
    });
    expect(healthyFollowUp).toMatchObject({ ok: true, value: 42 });
  });

  it("has no ambient network, filesystem, Emscripten FS, or Node globals", async () => {
    const result = await executeQuickJs(
      `
        ({
          fetch: typeof fetch,
          XMLHttpRequest: typeof XMLHttpRequest,
          WebSocket: typeof WebSocket,
          require: typeof require,
          process: typeof process,
          fs: typeof fs,
          FS: typeof FS,
          MEMFS: typeof MEMFS,
          NODEFS: typeof NODEFS,
          module: typeof module,
          Buffer: typeof Buffer,
          escapedProcess: (() => {
            try {
              return typeof globalThis.constructor.constructor("return process")();
            } catch (error) {
              return error instanceof ReferenceError ? "ReferenceError" : "other-error";
            }
          })(),
        })
      `,
      {
        memoryLimitBytes: 8 * mib,
        timeoutMs: 100,
      }
    );

    expect(result).toEqual({
      error: null,
      memoryLimitExceeded: false,
      ok: true,
      timedOut: false,
      value: {
        Buffer: "undefined",
        FS: "undefined",
        MEMFS: "undefined",
        NODEFS: "undefined",
        WebSocket: "undefined",
        XMLHttpRequest: "undefined",
        escapedProcess: "ReferenceError",
        fetch: "undefined",
        fs: "undefined",
        module: "undefined",
        process: "undefined",
        require: "undefined",
      },
    });
  });

  it("cannot import node:fs when no module loader is installed", async () => {
    const result = await executeQuickJs('import fs from "node:fs";', {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      error: { kind: "exception" },
      ok: false,
      timedOut: false,
    });
    if (!result.ok) {
      expect(result.error.message).toMatch(/module|loader|node:fs/i);
    }
  });

  it("calls only a deliberately granted host function and round-trips a value", async () => {
    let observedHostInput: string | undefined;
    const result = await executeQuickJs('hostEcho("from guest")', {
      hostFunctions: [
        {
          name: "hostEcho",
          invoke: (input: string): string => {
            observedHostInput = input;
            return `${input} -> from host`;
          },
        },
      ],
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(observedHostInput).toBe("from guest");
    expect(result).toMatchObject({
      ok: true,
      value: "from guest -> from host",
    });
  });

  it("does not invent an ungranted host bridge", async () => {
    const result = await executeQuickJs("typeof hostEcho", {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ ok: true, value: "undefined" });
  });
});
