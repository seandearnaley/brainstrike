import * as variantModule from "@jitl/quickjs-ng-wasmfile-release-sync";
import {
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSSyncVariant,
  type QuickJSWASMModule,
  Scope,
  isFail,
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";

export interface StringHostFunction {
  readonly name: string;
  readonly invoke: (input: string) => string;
}

export interface SandboxOptions {
  readonly hostFunctions?: readonly StringHostFunction[];
  readonly memoryLimitBytes: number;
  readonly timeoutMs: number;
}

export type SandboxFailureKind = "exception" | "memory-limit" | "timeout";

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
  modulePromise ??= newQuickJSWASMModuleFromVariant(getVariant());
  return modulePromise;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function normalizeGuestError(value: unknown): { message: string; name: string } {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Error";
    const message =
      typeof record.message === "string" ? record.message : String(value);
    return { message, name };
  }

  return { message: String(value), name: "Error" };
}

function installHostFunction(
  context: QuickJSContext,
  scope: Scope,
  grant: StringHostFunction
): void {
  if (grant.name.length === 0) {
    throw new TypeError("host function name must not be empty");
  }

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
    const deadlineHandler = shouldInterruptAfterDeadline(
      Date.now() + options.timeoutMs
    );
    runtime.setInterruptHandler((currentRuntime) => {
      const shouldInterrupt = deadlineHandler(currentRuntime) === true;
      interrupted ||= shouldInterrupt;
      return shouldInterrupt;
    });

    const context = scope.manage(runtime.newContext());
    for (const grant of options.hostFunctions ?? []) {
      installHostFunction(context, scope, grant);
    }

    const callResult = context.evalCode(code, "agent-code.js");

    if (isFail(callResult)) {
      const errorHandle = scope.manage(callResult.error);
      const guestError = normalizeGuestError(context.dump(errorHandle));
      const memoryLimitExceeded =
        !interrupted && /out of memory|allocation failed/i.test(guestError.message);
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
    }

    const valueHandle = scope.manage(callResult.value);
    return {
      error: null,
      memoryLimitExceeded: false,
      ok: true,
      timedOut: false,
      value: context.dump(valueHandle) as unknown,
    };
  });
}
