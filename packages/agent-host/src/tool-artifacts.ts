import { createHash } from 'node:crypto';
import {
  type ScopedToolOutputArtifactReader,
  type SerializedToolOutput,
  toolOutputArtifactCandidate,
  toolOutputArtifactModelOutput,
} from '@brainstrike/agent/tool-runtime';
import {
  NATIVE_TOOL_ID,
  NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS,
} from '@brainstrike/assistant-contract';
import {
  TOOL_OUTPUT_ARTIFACT_RETENTION_MS,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import type { HostRunState } from './core-state.js';
import { jsonValue } from './json-value.js';
import type { HostTool } from './ports.js';

const NON_DURABLE: ReadonlySet<string> = new Set([...NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS, 'skill']);
const TEXT_ENCODER = new TextEncoder();

type ToolResultOutput = Awaited<ReturnType<NonNullable<HostTool['toModelOutput']>>>;

/**
 * The opaque artifact id of one committed tool output: a digest of its run and
 * call, so it names no thread, path or storage location.
 */
export function hostArtifactId(runId: string, toolCallId: string): string {
  return createHash('sha256')
    .update(`${runId}\u0000${toolCallId}`)
    .digest('base64url')
    .slice(0, 32);
}

/** The catalog id a host tool answers for; other tools keep their provider name. */
export function hostToolCatalogId(name: string, tool: HostTool): string {
  return tool.permissionToolId ?? name;
}

/**
 * One committed output as the legacy settlement measures it: undefined when
 * it stays inline or its tool is never durable. Settlement and reads share it,
 * so an id the model holds a cursor for always re-serializes the same way.
 *
 * A pure function of committed run state: `outputs`, `effectTools` and
 * `artifactSettled` are all folded from the run's own events, so a replay
 * answers exactly as the live run did. `artifactSettled` carries the one
 * decision size cannot show — an output its own model projection would clip —
 * which the effect commit records (`projectionClipped`) rather than this
 * projection re-deriving it.
 */
function settledOutput(run: HostRunState, toolCallId: string): SerializedToolOutput | undefined {
  const toolName = run.effectTools.get(toolCallId);
  if (toolName === undefined || NON_DURABLE.has(toolName) || !run.outputs.has(toolCallId)) {
    return;
  }
  return toolOutputArtifactCandidate(
    run.outputs.get(toolCallId),
    toolName,
    run.artifactSettled.has(toolCallId) ? { wouldTruncateModelOutput: () => true } : {}
  )?.serialized;
}

/**
 * The run's sole eligible artifact reader, by its callable name. An ambiguous
 * catalog refuses rather than paging through an arbitrary one of them; no
 * reader at all is ordinary (the run simply cannot page) and returns undefined.
 */
export function requireSoleHostArtifactReader(
  tools: Readonly<Record<string, HostTool>>
): string | undefined {
  const readers = Object.entries(tools)
    .filter(
      ([name, tool]) => hostToolCatalogId(name, tool) === NATIVE_TOOL_ID.readToolOutputArtifact
    )
    .map(([name]) => name);
  if (readers.length > 1) {
    throw new Error(
      `Durable tool output requires one eligible artifact reader; this run registered ${readers.length}.`
    );
  }
  return readers[0];
}

function reference(
  run: HostRunState,
  toolCallId: string,
  serialized: SerializedToolOutput
): ToolOutputArtifactReference {
  const committedAt = run.outputCommittedAt.get(toolCallId);
  if (committedAt === undefined) {
    throw new Error('A settled tool output has no committed effect time');
  }
  return {
    byteLength: serialized.byteLength,
    expiresAt: new Date(committedAt + TOOL_OUTPUT_ARTIFACT_RETENTION_MS).toISOString(),
    format: serialized.format,
    id: hostArtifactId(run.id, toolCallId),
  };
}

/** The SDK's default projection of a result that has no tool-specific one. */
function defaultModelOutput(output: unknown): ToolResultOutput {
  return typeof output === 'string'
    ? { type: 'text', value: output }
    : { type: 'json', value: jsonValue(output) };
}

/**
 * Legacy durable settlement over the host's committed outputs: when the run
 * can page artifacts, an output past the inline ceiling reaches the model as
 * its first artifact page with a continuation cursor instead of a clipped
 * projection. The complete output is the committed `effect.finished`.
 *
 * An MCP result that stays inline on size yet loses data to its own bounded
 * projection settles too, so the model pages it instead of receiving an
 * unrecoverable `tool_result_truncated` notice. At the 128k anchor that band
 * is roughly 6 000-12 000 bytes, since the inline ceiling is fixed while the
 * projection budget scales. That decision is NOT made here: the effect commit
 * makes it once and commits it (`effect.finished.projectionClipped`), because
 * a replay rebuilds outputs from those events and a cursor the model already
 * holds has to keep resolving.
 */
export function settleHostToolOutputs(
  run: HostRunState,
  tools: Readonly<Record<string, HostTool>>
): Readonly<Record<string, HostTool>> {
  const reader = requireSoleHostArtifactReader(tools);
  if (!reader) {
    return tools;
  }
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (tool.interaction) {
        return [name, tool];
      }
      const project = tool.toModelOutput;
      const toModelOutput: NonNullable<HostTool['toModelOutput']> = async (options) => {
        const serialized = settledOutput(run, options.toolCallId);
        if (!serialized) {
          return project ? await project(options) : defaultModelOutput(options.output);
        }
        return toolOutputArtifactModelOutput({
          content: serialized.content,
          readerToolName: reader,
          reference: reference(run, options.toolCallId, serialized),
        }) as ToolResultOutput;
      };
      return [name, { ...tool, toModelOutput }];
    })
  );
}

/**
 * The thread's artifact reader over committed outputs: an id resolves only to
 * a settled output of a run of this thread, re-serialized exactly as
 * settlement measured it, and only until its retention expires.
 */
export function hostArtifactReader(
  runs: () => Iterable<HostRunState>,
  threadId: string,
  now: () => number = Date.now
): ScopedToolOutputArtifactReader {
  const locate = (artifactId: string) => {
    for (const run of runs()) {
      if (run.threadId !== threadId) {
        continue;
      }
      for (const toolCallId of run.outputs.keys()) {
        if (hostArtifactId(run.id, toolCallId) === artifactId) {
          return { run, toolCallId };
        }
      }
    }
    return;
  };
  return {
    readRange: async ({ artifactId, limitBytes, offsetByte }) => {
      const located = locate(artifactId);
      const serialized = located && settledOutput(located.run, located.toolCallId);
      if (!(located && serialized)) {
        return { status: 'not_found' };
      }
      const artifact = reference(located.run, located.toolCallId, serialized);
      if (now() >= Date.parse(artifact.expiresAt)) {
        return { reference: artifact, status: 'expired' };
      }
      const bytes = TEXT_ENCODER.encode(serialized.content).subarray(
        offsetByte,
        offsetByte + limitBytes
      );
      return {
        bytes,
        endByte: offsetByte + bytes.byteLength,
        offsetByte,
        reference: artifact,
        status: 'found',
      };
    },
  };
}
