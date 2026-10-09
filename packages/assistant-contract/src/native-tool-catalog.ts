/**
 * Canonical native tool ids shared by browser-safe UI metadata, the hosted
 * desktop registry, and the agent runtime.
 *
 * Every export here is DERIVED from the single definition list in
 * `./native-tools/index.ts` (`NATIVE_TOOLS`, BST-1646): the id partitions, the
 * web/local surface subsets, and the non-durable-output set are read off each
 * `defineNativeTool` declaration, so none of them can be stated twice. Keep
 * this module safe to import from renderer bundles — the definitions carry
 * Zod input schemas (zod is browser-safe) and nothing Mastra/Node-only.
 */

import type { NativeToolSurface } from './native-tools/define.js';
import {
  type DesktopNativeTool,
  NATIVE_TOOL_REGISTRIES,
  type NativeTool,
} from './native-tools/index.js';

export const NATIVE_TOOL_ID = NATIVE_TOOL_REGISTRIES.nativeToolId;

/** The camelCase catalog keys (`askUser`, `skillRead`, …) — one per native tool. */
export type NativeToolKey = keyof typeof NATIVE_TOOL_ID;

export type DesktopNativeToolId = DesktopNativeTool['id'];
export type SkillNativeToolId = Extract<NativeTool, { readonly kind: 'skill' }>['id'];
export type NativeToolId = NativeTool['id'];

type DesktopToolOnSurface<Surface extends NativeToolSurface> = DesktopNativeTool extends infer Tool
  ? Tool extends { readonly surfaces: readonly (infer Listed)[] }
    ? Surface extends Listed
      ? Tool
      : never
    : never
  : never;

export type WebNativeToolId = DesktopToolOnSurface<'web'>['id'];
export type LocalDesktopNativeToolId = Extract<
  DesktopNativeTool,
  { readonly localProvider: 'offered' }
>['id'];

export const DESKTOP_NATIVE_TOOL_IDS: readonly DesktopNativeToolId[] =
  NATIVE_TOOL_REGISTRIES.ids.desktop;

export const WEB_NATIVE_TOOL_IDS: readonly WebNativeToolId[] = NATIVE_TOOL_REGISTRIES.ids.web;

/**
 * Eager-core-only tools offered to the built-in local model — the desktop
 * definitions with `localProvider: 'offered'`.
 *
 * `askUser` and `submitPlan` are the other critical tools, but they are
 * `unregistered`: the local provider has no suspend/resume implementation.
 * `writeWorkspaceFile` is critical for hosted small-model create reachability,
 * but remains excluded here: the local capability surface is an explicit,
 * separately qualified product contract rather than every critical hosted tool.
 */
export const LOCAL_DESKTOP_NATIVE_TOOL_IDS: readonly LocalDesktopNativeToolId[] =
  NATIVE_TOOL_REGISTRIES.ids.local;

/**
 * Desktop tools with no executor under the built-in local provider
 * (`localProvider: 'unregistered'`): every executor fold skips them for a local
 * run, and Main never describes them to one.
 */
export const LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS: ReadonlySet<string> = new Set(
  NATIVE_TOOL_REGISTRIES.ids.localUnregistered
);

/** Native tool results that must never be retained by durable artifact settlement. */
export const NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS: readonly DesktopNativeToolId[] =
  NATIVE_TOOL_REGISTRIES.ids.nonDurableOutput;

export const SKILL_NATIVE_TOOL_IDS: readonly SkillNativeToolId[] = NATIVE_TOOL_REGISTRIES.ids.skill;

/**
 * Settled-history allowlists for the two projection processors, declared per
 * tool as `history.recencyPrunable` / `history.staleReplayable`. Both are
 * ALLOWLISTS: a tool that declares neither stays verbatim in provider history.
 */
export const RECENCY_PRUNABLE_NATIVE_TOOL_IDS: readonly NativeToolId[] =
  NATIVE_TOOL_REGISTRIES.ids.recencyPrunable;
export const STALE_REPLAYABLE_NATIVE_TOOL_IDS: readonly NativeToolId[] =
  NATIVE_TOOL_REGISTRIES.ids.staleReplayable;

export const NATIVE_TOOL_IDS: readonly NativeToolId[] = NATIVE_TOOL_REGISTRIES.ids.native;

const DESKTOP_NATIVE_TOOL_ID_SET: ReadonlySet<string> = new Set(DESKTOP_NATIVE_TOOL_IDS);
const NATIVE_TOOL_ID_SET: ReadonlySet<string> = new Set(NATIVE_TOOL_IDS);
const SKILL_NATIVE_TOOL_ID_SET: ReadonlySet<string> = new Set(SKILL_NATIVE_TOOL_IDS);

export function isDesktopNativeToolId(value: string): value is DesktopNativeToolId {
  return DESKTOP_NATIVE_TOOL_ID_SET.has(value);
}

export function isNativeToolId(value: string): value is NativeToolId {
  return NATIVE_TOOL_ID_SET.has(value);
}

export function isSkillNativeToolId(value: string): value is SkillNativeToolId {
  return SKILL_NATIVE_TOOL_ID_SET.has(value);
}
