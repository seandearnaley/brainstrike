/**
 * `permission.gate.resolved` (debug pack, 2026-09-15): the permission gate this
 * leg's Agent was BUILT with, minted once on the fresh-turn prelude
 * (`attempt-legs.ts`, beside `mcp.tools.unavailable`). It answers "why did an
 * approval card appear?" and "why did the model never see that tool?".
 *
 * Informational: status `'completed'`, never `'running'`, and NOT in
 * `isAlwaysVisibleRunEvent` (the approval card is the user-facing surface).
 *
 * Metadata keys must survive `sanitizeAssistantRunEventMetadata`, which the
 * desktop writer and the history repository both run and which drops any key
 * containing `session`: the snapshot's session grants travel as
 * `grantedCategories`.
 */
import type {
  PermissionPolicies,
  PermissionToolGateSnapshot,
  ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import type { StreamChunk } from '../types';
import type {
  PermissionAskToolMetadata,
  PermissionDeniedToolMetadata,
} from './permission-tool-gate';
import { makeRunDetailEventChunk } from './stream-run-event-chunks';

export interface PermissionGateToolEntry {
  readonly riskCategory: ToolRiskCategory;
  /** The original (pre-sanitization) tool name. */
  readonly tool: string;
}

export interface PermissionGateSummary {
  /** Tools gated to `'ask'` and KEPT: exactly the set the live gate suspends. */
  readonly askTools: readonly PermissionGateToolEntry[];
  /** The snapshot's `defaultRisk`; null when unset (the gate then applies `'mcp'`). */
  readonly defaultRisk: ToolRiskCategory | null;
  /** Tools the policy denied: omitted from the map the model sees. */
  readonly deniedTools: readonly PermissionGateToolEntry[];
  /** The snapshot's "allow this category for the session" grants. */
  readonly grantedCategories: readonly ToolRiskCategory[];
  /** Ask tools the storage fail-safe omitted: no storage could resume an approval. */
  readonly omittedAskTools: readonly PermissionGateToolEntry[];
  readonly overrideCount: number;
  readonly policies: PermissionPolicies;
  readonly yolo: boolean;
}

function toEntry(meta: PermissionAskToolMetadata | PermissionDeniedToolMetadata) {
  return { riskCategory: meta.riskCategory, tool: meta.originalName };
}

/**
 * Null when no snapshot gated the run. `gatedAskTools` is the gate's own ask
 * set; `keptAskTools` is what survived the storage fail-safe
 * (`resolveAskToolsForRun`), and the difference is `omittedAskTools`.
 */
export function summarizePermissionGate(input: {
  readonly deniedTools: ReadonlyMap<string, PermissionDeniedToolMetadata>;
  readonly gatedAskTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  readonly keptAskTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  readonly snapshot: PermissionToolGateSnapshot | undefined;
}): PermissionGateSummary | null {
  const { snapshot } = input;
  if (!snapshot) {
    return null;
  }
  return {
    askTools: [...input.keptAskTools.values()].map(toEntry),
    defaultRisk: snapshot.defaultRisk ?? null,
    deniedTools: [...input.deniedTools.values()].map(toEntry),
    grantedCategories: [...(snapshot.sessionGrants ?? [])],
    omittedAskTools: [...input.gatedAskTools]
      .filter(([sanitizedId]) => !input.keptAskTools.has(sanitizedId))
      .map(([, meta]) => toEntry(meta)),
    overrideCount: Object.keys(snapshot.perToolOverrides ?? {}).length,
    policies: { ...snapshot.policies },
    yolo: snapshot.yolo,
  };
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function countByRisk(tools: readonly PermissionGateToolEntry[]): string {
  const counts = new Map<ToolRiskCategory, number>();
  for (const tool of tools) {
    counts.set(tool.riskCategory, (counts.get(tool.riskCategory) ?? 0) + 1);
  }
  return [...counts].map(([risk, count]) => `${risk}: ${count}`).join(', ');
}

function describeGate(summary: PermissionGateSummary): string {
  const byRisk = summary.askTools.length > 0 ? ` (${countByRisk(summary.askTools)})` : '';
  const omitted =
    summary.omittedAskTools.length > 0
      ? `${countOf(summary.omittedAskTools.length, 'ask tool')} omitted without approval storage; `
      : '';
  const grants =
    summary.grantedCategories.length > 0 ? summary.grantedCategories.join(', ') : 'none';
  return `${countOf(summary.askTools.length, 'tool')} gated to ask${byRisk}; ${summary.deniedTools.length} denied; ${omitted}session grants: ${grants}`;
}

/** One `'completed'` row, or nothing when no policy gated the run. */
export function makePermissionGateResolvedChunks(
  summary: PermissionGateSummary | null
): StreamChunk[] {
  if (summary === null) {
    return [];
  }
  return [
    makeRunDetailEventChunk(
      'permission.gate.resolved',
      'completed',
      'Permission gate resolved',
      describeGate(summary),
      {
        askTools: summary.askTools.map((entry) => ({ ...entry })),
        defaultRisk: summary.defaultRisk,
        deniedTools: summary.deniedTools.map((entry) => ({ ...entry })),
        grantedCategories: [...summary.grantedCategories],
        omittedAskTools: summary.omittedAskTools.map((entry) => ({ ...entry })),
        overrideCount: summary.overrideCount,
        policies: { ...summary.policies },
        yolo: summary.yolo,
      }
    ),
  ];
}
