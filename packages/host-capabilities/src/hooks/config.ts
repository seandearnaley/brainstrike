/**
 * Tool-lifecycle hook configuration loading (desktop / main-process only).
 *
 * Strict, multi-root, fail-CLOSED loader. A malformed or untrusted file
 * contributes ZERO hooks AND records a structured `HookConfigError` (D2); the
 * assistant still runs. There is NO `catch {}` swallow — every failure is
 * surfaced through the result's `errors`.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256OfBuffer } from './trust.js';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookConfigError,
  type HookConfigSource,
  type HookDefinition,
  type HookEventName,
  type HookMatcher,
  type HooksConfigLoadResult,
  type LoadedHook,
  type LoadedHooksByEvent,
} from './types.js';

const VALID_EVENTS: readonly HookEventName[] = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Notification',
];

export const MAX_HOOKS_CONFIG_BYTES = 1024 * 1024;
export const INVALID_PROJECT_HOOK_CONFIG = `hooks.json must be a regular file no larger than ${MAX_HOOKS_CONFIG_BYTES} bytes`;

export interface HookConfigRootInput {
  readonly absPath: string;
  /**
   * The renderer-attested approved SHA-256 for this root (raw file bytes), or
   * undefined if unapproved. The loader RE-READS + RE-HASHES the file's bytes
   * and trusts the root ONLY when the disk hash equals this — computed from the
   * SAME single read it then parses, so the loaded commands are provably the
   * ones whose hash was trusted (no read-vs-hash TOCTOU window).
   */
  readonly approvedSha256?: string;
  readonly rootId: string;
}

export interface HookConfigInput {
  /**
   * Aggregate wall-clock ceiling for the PRE-STREAM `UserPromptSubmit` phase.
   * If the combined declared timeout of all UserPromptSubmit hooks reaches this,
   * the phase is disabled fail-LOUD (a `HookConfigError`) — over-budget config
   * never silently truncates. In-stream phases have no aggregate cap here (they
   * rely on the per-hook SIGKILL + the stream inactivity watchdog).
   */
  readonly aggregateTimeoutMs: number;
  /** Absolute path to the global hooks file (`~/.brainstrike/hooks.json`). */
  readonly globalPath: string;
  /** = `resolveToolTimeoutMs()` (D4). Any hook `timeout >=` this disables the file. */
  readonly maxHookTimeoutMs: number;
  /** cwd assigned to GLOBAL hooks (the primary/first mounted root). */
  readonly primaryRootCwd: string;
  /** Mounted desktop roots, in scan order, each with its approved hash (if any). */
  readonly roots: readonly HookConfigRootInput[];
}

/** Single raw-byte read; null = missing/unreadable. */
function readFileBytesOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function readProjectHookConfig(
  path: string
): Buffer | null | typeof INVALID_PROJECT_HOOK_CONFIG {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_HOOKS_CONFIG_BYTES) {
        return INVALID_PROJECT_HOOK_CONFIG;
      }
      const bytes = Buffer.allocUnsafe(stat.size);
      const bytesRead = readSync(fd, bytes, 0, bytes.length, null);
      return bytes.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function getGlobalHooksPath(): string {
  return join(homedir(), '.brainstrike', 'hooks.json');
}

export function getProjectHooksPath(rootAbsPath: string): string {
  return join(rootAbsPath, '.brainstrike', 'hooks.json');
}

interface ValidatedFile {
  readonly hooks: LoadedHooksByEvent;
}

type FileValidation =
  | { readonly ok: true; readonly value: ValidatedFile }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateMatcher(raw: unknown): {
  readonly matcher?: HookMatcher;
  readonly regex?: RegExp;
} {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new Error('matcher must be an object');
  }
  const toolName = raw['tool_name'];
  if (toolName === undefined) {
    return { matcher: {} };
  }
  if (typeof toolName !== 'string') {
    throw new Error('matcher.tool_name must be a string');
  }
  // Throws on an un-compilable pattern — caught by validateFile (whole file disabled).
  const regex = new RegExp(toolName);
  return { matcher: { tool_name: toolName }, regex };
}

function validateHook(
  raw: unknown,
  maxHookTimeoutMs: number
): { readonly definition: HookDefinition; readonly toolNameRegex?: RegExp } {
  if (!isRecord(raw)) {
    throw new Error('hook must be an object');
  }
  if (raw['type'] !== 'command') {
    throw new Error("hook.type must be 'command'");
  }
  const command = raw['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('hook.command must be a non-empty string');
  }

  const timeoutRaw = raw['timeout'];
  let timeout: number | undefined;
  if (timeoutRaw !== undefined) {
    if (
      typeof timeoutRaw !== 'number' ||
      !Number.isInteger(timeoutRaw) ||
      timeoutRaw <= 0 ||
      timeoutRaw >= maxHookTimeoutMs
    ) {
      throw new Error(
        `hook.timeout must be a positive integer < ${maxHookTimeoutMs}ms (was ${String(timeoutRaw)})`
      );
    }
    timeout = timeoutRaw;
  }

  const description = raw['description'];
  if (description !== undefined && typeof description !== 'string') {
    throw new Error('hook.description must be a string');
  }

  const { matcher, regex } = validateMatcher(raw['matcher']);

  const definition: HookDefinition = {
    command,
    type: 'command',
    ...(matcher && matcher.tool_name !== undefined ? { matcher } : {}),
    ...(timeout === undefined ? {} : { timeout }),
    ...(description === undefined ? {} : { description }),
  };
  return { definition, ...(regex ? { toolNameRegex: regex } : {}) };
}

interface ValidateSource {
  readonly cwd: string;
  readonly rootId?: string;
  readonly scope: 'global' | 'project';
}

/** Validate one event's hook array into LoadedHooks. Throws on any invalid entry. */
function validateEventHooks(
  list: unknown,
  event: HookEventName,
  source: ValidateSource,
  maxHookTimeoutMs: number
): LoadedHook[] {
  if (!Array.isArray(list)) {
    throw new Error(`${event} must be an array`);
  }
  return list.map((entry) => {
    const { definition, toolNameRegex } = validateHook(entry, maxHookTimeoutMs);
    return {
      definition,
      source: {
        cwd: source.cwd,
        scope: source.scope,
        ...(source.rootId ? { rootId: source.rootId } : {}),
      },
      ...(toolNameRegex ? { toolNameRegex } : {}),
    };
  });
}

function validateFile(
  raw: string,
  source: ValidateSource,
  maxHookTimeoutMs: number
): FileValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
  if (!isRecord(parsed)) {
    return { message: 'root of hooks.json must be a JSON object', ok: false };
  }

  const hooks: Partial<Record<HookEventName, LoadedHook[]>> = {};
  try {
    for (const event of VALID_EVENTS) {
      if (parsed[event] === undefined) {
        continue;
      }
      const loaded = validateEventHooks(parsed[event], event, source, maxHookTimeoutMs);
      if (loaded.length > 0) {
        hooks[event] = loaded;
      }
    }
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), ok: false };
  }

  return { ok: true, value: { hooks } };
}

function mergeInto(
  target: Partial<Record<HookEventName, LoadedHook[]>>,
  source: LoadedHooksByEvent
): void {
  for (const event of VALID_EVENTS) {
    const incoming = source[event];
    if (!incoming || incoming.length === 0) {
      continue;
    }
    const existing = target[event] ?? [];
    target[event] = [...existing, ...incoming];
  }
}

/** Sum of the phase's declared per-hook timeouts (unspecified = default). */
function sumDeclaredTimeouts(hooks: readonly LoadedHook[]): number {
  return hooks.reduce((acc, hook) => acc + (hook.definition.timeout ?? DEFAULT_HOOK_TIMEOUT_MS), 0);
}

export function loadHooksConfig(input: HookConfigInput): HooksConfigLoadResult {
  const merged: Partial<Record<HookEventName, LoadedHook[]>> = {};
  const errors: HookConfigError[] = [];
  const sources: HookConfigSource[] = [];

  // Global first. Not trust-gated (the user's own machine), single read.
  {
    const bytes = readFileBytesOrNull(input.globalPath);
    sources.push({ exists: bytes !== null, path: input.globalPath, scope: 'global' });
    if (bytes !== null) {
      const validated = validateFile(
        bytes.toString('utf8'),
        { cwd: input.primaryRootCwd, scope: 'global' },
        input.maxHookTimeoutMs
      );
      if (validated.ok) {
        mergeInto(merged, validated.value.hooks);
      } else {
        errors.push({ message: validated.message, path: input.globalPath, scope: 'global' });
      }
    }
  }

  // Then each root, in input order. Trust + parse from ONE read: hash the bytes,
  // compare to the approval, and parse those SAME bytes only when trusted.
  for (const root of input.roots) {
    const filePath = getProjectHooksPath(root.absPath);
    const bytes = readProjectHookConfig(filePath);
    sources.push({ exists: bytes !== null, path: filePath, rootId: root.rootId, scope: 'project' });
    if (bytes === null) {
      continue;
    }
    if (typeof bytes === 'string') {
      errors.push({
        message: bytes,
        path: filePath,
        rootId: root.rootId,
        scope: 'project',
      });
      continue;
    }
    const trusted =
      root.approvedSha256 !== undefined && sha256OfBuffer(bytes) === root.approvedSha256;
    if (!trusted) {
      errors.push({
        message: 'untrusted; approve in Settings > Hooks',
        path: filePath,
        rootId: root.rootId,
        scope: 'project',
      });
      continue;
    }
    const validated = validateFile(
      bytes.toString('utf8'),
      { cwd: root.absPath, rootId: root.rootId, scope: 'project' },
      input.maxHookTimeoutMs
    );
    if (validated.ok) {
      mergeInto(merged, validated.value.hooks);
    } else {
      errors.push({
        message: validated.message,
        path: filePath,
        rootId: root.rootId,
        scope: 'project',
      });
    }
  }

  // Pre-stream aggregate bound (I1): the combined UserPromptSubmit budget must
  // stay under the ceiling. Over-budget → disable the phase fail-LOUD.
  const userPrompt = merged.UserPromptSubmit;
  if (userPrompt && userPrompt.length > 0) {
    const total = sumDeclaredTimeouts(userPrompt);
    if (total >= input.aggregateTimeoutMs) {
      errors.push({
        message: `UserPromptSubmit hooks' combined timeout ${total}ms reaches the ${input.aggregateTimeoutMs}ms pre-stream aggregate budget; phase disabled`,
        path: 'UserPromptSubmit (aggregate)',
        scope: 'global',
      });
      // Disable the phase (empty = no hooks run) fail-closed.
      merged.UserPromptSubmit = [];
    }
  }

  return { errors, hooks: merged, sources };
}
