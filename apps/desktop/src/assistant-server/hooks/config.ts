/**
 * Tool-lifecycle hook configuration loading (desktop / main-process only).
 *
 * Strict, multi-root, fail-CLOSED loader. A malformed or untrusted file
 * contributes ZERO hooks AND records a structured `HookConfigError` (D2); the
 * assistant still runs. There is NO `catch {}` swallow — every failure is
 * surfaced through the result's `errors`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  HookConfigError,
  HookConfigSource,
  HookDefinition,
  HookEventName,
  HookMatcher,
  HooksConfigLoadResult,
  LoadedHook,
  LoadedHooksByEvent,
} from './types';

const VALID_EVENTS: readonly HookEventName[] = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Notification',
];

export interface HookConfigRootInput {
  readonly absPath: string;
  readonly rootId: string;
  readonly trusted: boolean;
}

export interface HookConfigInput {
  /** Absolute path to the global hooks file (`~/.brainstrike/hooks.json`). */
  readonly globalPath: string;
  /** = `resolveToolTimeoutMs()` (D4). Any hook `timeout >=` this disables the file. */
  readonly maxHookTimeoutMs: number;
  /** cwd assigned to GLOBAL hooks (the primary/first mounted root). */
  readonly primaryRootCwd: string;
  /** Mounted desktop roots, in scan order, each with its resolved trust. */
  readonly roots: readonly HookConfigRootInput[];
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

export function loadHooksConfig(input: HookConfigInput): HooksConfigLoadResult {
  const merged: Partial<Record<HookEventName, LoadedHook[]>> = {};
  const errors: HookConfigError[] = [];
  const sources: HookConfigSource[] = [];

  // Global first.
  {
    const exists = existsSync(input.globalPath);
    sources.push({ exists, path: input.globalPath, scope: 'global' });
    if (exists) {
      const raw = readFileSync(input.globalPath, 'utf8');
      const validated = validateFile(
        raw,
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

  // Then each root, in input order.
  for (const root of input.roots) {
    const filePath = getProjectHooksPath(root.absPath);
    const exists = existsSync(filePath);
    sources.push({ exists, path: filePath, rootId: root.rootId, scope: 'project' });
    if (!exists) {
      continue;
    }
    if (!root.trusted) {
      errors.push({
        message: 'untrusted; approve in Settings > Hooks',
        path: filePath,
        rootId: root.rootId,
        scope: 'project',
      });
      continue;
    }
    const raw = readFileSync(filePath, 'utf8');
    const validated = validateFile(
      raw,
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

  return { errors, hooks: merged, sources };
}
