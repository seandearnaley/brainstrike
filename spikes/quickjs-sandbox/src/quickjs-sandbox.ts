import * as variantModule from "@jitl/quickjs-ng-wasmfile-release-sync";
import {
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSSyncVariant,
  type QuickJSWASMModule,
  Scope,
  isFail,
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";

/**
 * `invoke` runs synchronously on the host, on the same tick as the guest call
 * that triggered it. The QuickJS interrupt handler only preempts *guest*
 * bytecode — it cannot preempt a host callback in progress. A slow or
 * blocking `invoke` therefore makes `executeQuickJs` exceed, or never
 * honour, `timeoutMs`, even though the surrounding API advertises a
 * `"timeout"` failure kind. Every grant must itself be bounded and
 * non-blocking (e.g. a `fetch` bridge must apply its own request timeout).
 */
export interface StringHostFunction {
  readonly name: string;
  readonly invoke: (input: string) => string;
}

export interface SandboxOptions {
  readonly hostFunctions?: readonly StringHostFunction[];
  readonly memoryLimitBytes: number;
  readonly timeoutMs: number;
}

export type SandboxFailureKind =
  | "exception"
  | "memory-limit"
  | "timeout"
  | "unresolved-promise";

export interface SandboxSuccess {
  readonly error: null;
  readonly memoryLimitExceeded: false;
  readonly ok: true;
  readonly timedOut: false;
  readonly value: unknown;
}

export interface SandboxFailure {
  readonly error: {
    readonly kind: SandboxFailureKind;
    readonly message: string;
    readonly name: string;
  };
  readonly memoryLimitExceeded: boolean;
  readonly ok: false;
  readonly timedOut: boolean;
  readonly value: null;
}

export type SandboxResult = SandboxSuccess | SandboxFailure;

/** Defensive backstop against a pathological job that never exhausts the
 * queue without ever tripping the interrupt handler. In practice the
 * interrupt handler fires during job execution too (verified empirically),
 * so this cap should never bind in normal operation. */
const MAX_PENDING_JOB_ITERATIONS = 10_000;

let modulePromise: Promise<QuickJSWASMModule> | undefined;

function getVariant(): QuickJSSyncVariant {
  // TypeScript 7's NodeNext interop models this package's default export as a
  // nested module namespace, although Node exposes the variant object here.
  const candidate: unknown = variantModule.default;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("type" in candidate) ||
    candidate.type !== "sync" ||
    !("importFFI" in candidate) ||
    typeof candidate.importFFI !== "function" ||
    !("importModuleLoader" in candidate) ||
    typeof candidate.importModuleLoader !== "function"
  ) {
    throw new TypeError("QuickJS package did not export a synchronous variant");
  }
  return candidate as QuickJSSyncVariant;
}

function getModule(): Promise<QuickJSWASMModule> {
  // Clear the memo on rejection: `??=` would otherwise cache a *rejected*
  // promise for the life of the process, so a transient WASM-load failure
  // (or the first caller's unhandled rejection) would permanently poison
  // every later call with no way to retry.
  modulePromise ??= newQuickJSWASMModuleFromVariant(getVariant()).catch((error: unknown) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/** Coerces an arbitrary thrown value to a string without ever invoking a
 * guest-controlled `toString`/`valueOf` that could itself throw (e.g. a
 * dumped `{ toString: "not callable" }` object makes plain `String(value)`
 * throw a host `TypeError`, which would otherwise crash this function
 * instead of returning the promised structured `SandboxFailure`). */
function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unrepresentable thrown value]";
  }
}

function normalizeGuestError(value: unknown): { message: string; name: string } {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Error";
    const message =
      typeof record.message === "string" ? record.message : safeStringify(value);
    return { message, name };
  }

  return { message: safeStringify(value), name: "Error" };
}

/** Host-owned signal for "the configured cap actually held": guest-thrown
 * error *text* is fully attacker-controlled (a guest can `throw new
 * Error("out of memory")` without ever approaching the cap, or a genuine OOM
 * can surface with different wording), so it must never be the basis for
 * `memoryLimitExceeded`. `computeMemoryUsage()` reports the runtime's own
 * accounting instead; empirically, a real cap-triggered OOM leaves
 * `memory_used_size` far above `malloc_limit` (verified: ~2.1 GB reported vs
 * a 2 MiB cap), while ordinary execution stays far below it. */
function isMemoryLimitExceeded(
  runtime: QuickJSRuntime,
  context: QuickJSContext,
  scope: Scope,
  limitBytes: number
): boolean {
  const usageHandle = scope.manage(runtime.computeMemoryUsage());
  const usage = context.dump(usageHandle) as unknown;
  if (typeof usage !== "object" || usage === null || !("memory_used_size" in usage)) {
    return false;
  }
  const used = (usage as Record<string, unknown>).memory_used_size;
  return typeof used === "number" && used >= limitBytes;
}

function installHostFunction(
  context: QuickJSContext,
  scope: Scope,
  grant: StringHostFunction,
  grantedNames: Set<string>
): void {
  if (grant.name.length === 0) {
    throw new TypeError("host function name must not be empty");
  }
  if (grantedNames.has(grant.name)) {
    throw new TypeError(
      `host function "${grant.name}" was granted more than once; the host must own an unambiguous bridge surface`
    );
  }

  // Reject a grant that would silently clobber an existing global (a guest
  // intrinsic like JSON/Object/Array, or globalThis itself) rather than
  // last-writer-wins overwriting it with no signal.
  const existingHandle = scope.manage(context.getProp(context.global, grant.name));
  if (context.typeof(existingHandle) !== "undefined") {
    throw new TypeError(
      `host function "${grant.name}" would shadow an existing global; grant it under a different name`
    );
  }
  grantedNames.add(grant.name);

  const functionHandle = scope.manage(
    context.newFunction(grant.name, (...arguments_: QuickJSHandle[]) => {
      const argument = arguments_[0];
      if (argument === undefined) {
        throw new TypeError(`${grant.name} expects one string argument`);
      }
      if (context.typeof(argument) !== "string") {
        throw new TypeError(`${grant.name} expects one string argument`);
      }
      return context.newString(grant.invoke(context.getString(argument)));
    })
  );
  context.setProp(context.global, grant.name, functionHandle);
}

export async function executeQuickJs(
  code: string,
  options: SandboxOptions
): Promise<SandboxResult> {
  assertPositiveInteger(options.memoryLimitBytes, "memoryLimitBytes");
  assertPositiveInteger(options.timeoutMs, "timeoutMs");

  const quickJs = await getModule();

  return Scope.withScope((scope) => {
    const runtime = scope.manage(quickJs.newRuntime());
    runtime.setMemoryLimit(options.memoryLimitBytes);

    let interrupted = false;
    const deadlineHandler = shouldInterruptAfterDeadline(Date.now() + options.timeoutMs);
    runtime.setInterruptHandler((currentRuntime) => {
      const shouldInterrupt = deadlineHandler(currentRuntime) === true;
      interrupted ||= shouldInterrupt;
      return shouldInterrupt;
    });

    const context = scope.manage(runtime.newContext());
    const grantedNames = new Set<string>();
    for (const grant of options.hostFunctions ?? []) {
      installHostFunction(context, scope, grant, grantedNames);
    }

    const toFailure = (guestErrorValue: unknown): SandboxFailure => {
      const guestError = normalizeGuestError(guestErrorValue);
      const memoryLimitExceeded =
        !interrupted && isMemoryLimitExceeded(runtime, context, scope, options.memoryLimitBytes);
      const kind: SandboxFailureKind = interrupted
        ? "timeout"
        : memoryLimitExceeded
          ? "memory-limit"
          : "exception";

      return {
        error: { ...guestError, kind },
        memoryLimitExceeded,
        ok: false,
        timedOut: interrupted,
        value: null,
      };
    };

    const callResult = context.evalCode(code, "agent-code.js");

    if (isFail(callResult)) {
      const errorHandle = scope.manage(callResult.error);
      return toFailure(context.dump(errorHandle));
    }

    const valueHandle = scope.manage(callResult.value);

    // `evalCode` only runs the guest's synchronous prefix. Promises and
    // async functions enqueue jobs that must be drained explicitly — without
    // this, a rejected/thrown async result is never observed and silently
    // dumps as an empty object success. Draining is bounded by the same
    // interrupt deadline as the synchronous phase (verified empirically: the
    // interrupt handler fires during job execution too), so `timeoutMs`
    // still bounds async work.
    let jobIterations = 0;
    while (
      runtime.hasPendingJob() &&
      !interrupted &&
      jobIterations < MAX_PENDING_JOB_ITERATIONS
    ) {
      const jobsResult = scope.manage(runtime.executePendingJobs(1));
      if (isFail(jobsResult)) {
        const jobErrorHandle = scope.manage(jobsResult.error);
        return toFailure(context.dump(jobErrorHandle));
      }
      jobIterations += 1;
    }

    // `getPromiseState` also handles the non-promise case: it reports
    // `{ type: "fulfilled", value: <original value>, notAPromise: true }`,
    // so this one path covers both sync and async results.
    const promiseState = context.getPromiseState(valueHandle);

    if (promiseState.type === "rejected") {
      const rejectionHandle = scope.manage(promiseState.error);
      return toFailure(context.dump(rejectionHandle));
    }

    if (promiseState.type === "pending") {
      // No queued job will ever settle this (the drain loop above exhausted
      // hasPendingJob(), or was cut short by the deadline). Surfacing this
      // explicitly, instead of silently dumping an unsettled promise as
      // `{}`, is the point: a caller must not read "ok: true" as "the guest
      // program actually finished."
      return {
        error: {
          kind: "unresolved-promise",
          message: interrupted
            ? "the returned promise had not settled when the execution deadline was reached"
            : "the returned promise never settled and no further jobs are queued",
          name: "UnresolvedPromiseError",
        },
        memoryLimitExceeded: false,
        ok: false,
        timedOut: interrupted,
        value: null,
      };
    }

    const fulfilledHandle = scope.manage(promiseState.value);
    return {
      error: null,
      memoryLimitExceeded: false,
      ok: true,
      timedOut: false,
      value: context.dump(fulfilledHandle) as unknown,
    };
  });
}
