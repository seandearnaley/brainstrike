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
    // Only `kind` is a property of the API's own contract; the engine's
    // literal "interrupted" message text is an implementation detail that
    // could change on an engine bump without weakening the guarantee.
    expect(result).toMatchObject({
      error: { kind: "timeout" },
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

  it("does not classify a guest-spoofed message as a real memory-limit hit", async () => {
    // A guest that merely throws text resembling an OOM message must not be
    // able to forge `kind: "memory-limit"` / `memoryLimitExceeded: true` —
    // that signal has to come from the host's own memory accounting
    // (`computeMemoryUsage()`), not from parsing attacker-controlled text.
    const result = await executeQuickJs('throw new Error("out of memory")', {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      error: { kind: "exception", message: "out of memory" },
      memoryLimitExceeded: false,
      ok: false,
      timedOut: false,
    });
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

    // Pinned to the concrete failure shape (verified against the installed
    // engine) rather than a loose `/module|loader|node:fs/i` pattern, which
    // would also match QuickJS's own generic "import outside a module"
    // message — i.e. it could stay green even if a module loader were later
    // installed and silently started resolving "node:fs" to something real.
    expect(result).toMatchObject({
      error: {
        kind: "exception",
        message: "could not load module 'node:fs'",
        name: "ReferenceError",
      },
      ok: false,
      timedOut: false,
    });
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

  it("rejects a host-function grant that would shadow an existing global", async () => {
    // The value proposition over a wrapper like @sebastianwessel/quickjs is
    // that the host owns and audits the bridge surface. Silently clobbering
    // a guest intrinsic (JSON, in particular, has host-side reach through
    // context.dump's JSON-based serialization) is exactly the unaudited gap
    // that undermines that claim, so it must fail loudly instead.
    await expect(
      executeQuickJs("1", {
        hostFunctions: [{ invoke: (input) => input, name: "JSON" }],
        memoryLimitBytes: 8 * mib,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/would shadow an existing global/);
  });

  it("rejects duplicate host-function grants instead of last-writer-wins", async () => {
    await expect(
      executeQuickJs("1", {
        hostFunctions: [
          { invoke: (input) => input, name: "dup" },
          { invoke: (input) => input, name: "dup" },
        ],
        memoryLimitBytes: 8 * mib,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/granted more than once/);
  });

  it("surfaces a rejected promise instead of silently reporting success", async () => {
    // Before this was fixed, evalCode returned as soon as the synchronous
    // phase finished, the scope disposed the runtime immediately after, and
    // the queued rejection was discarded unobserved — the guest's thrown
    // error was reported as a clean `{ ok: true, value: {} }`.
    const result = await executeQuickJs('Promise.reject(new Error("boom"))', {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      error: { kind: "exception", message: "boom" },
      ok: false,
    });
  });

  it("surfaces an async function's thrown error instead of silently reporting success", async () => {
    const result = await executeQuickJs('(async () => { throw new Error("boom") })()', {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      error: { kind: "exception", message: "boom" },
      ok: false,
    });
  });

  it("resolves a genuinely fulfilled async result", async () => {
    const result = await executeQuickJs("(async () => 42)()", {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ ok: true, value: 42 });
  });

  it("reports a promise that never settles as unresolved rather than dumping it as {}", async () => {
    const result = await executeQuickJs("new Promise(() => {})", {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      error: { kind: "unresolved-promise" },
      ok: false,
    });
  });

  it("normalizes a thrown value whose own toString cannot be invoked", async () => {
    // `throw { toString: "not callable" }` makes plain `String(value)` throw
    // a host TypeError on the dumped object; executeQuickJs must still
    // return a structured SandboxFailure rather than rejecting itself.
    const result = await executeQuickJs('throw { toString: "not callable" }', {
      memoryLimitBytes: 8 * mib,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("exception");
      expect(typeof result.error.message).toBe("string");
    }
  });
});
