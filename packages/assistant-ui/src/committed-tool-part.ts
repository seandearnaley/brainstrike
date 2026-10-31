import type { ThreadAssistantMessage } from '@assistant-ui/react';
import { parsePartialJsonObject } from 'assistant-stream/utils';
import { mergeProviderMetadata, providerMetadata } from './committed-step-text';

type ToolPart = Extract<ThreadAssistantMessage['content'][number], { type: 'tool-call' }>;

function toolOwnership(
  prior: ToolPart | undefined,
  input: Readonly<Record<string, unknown>>,
  authoritative: boolean,
  retainInput: boolean
): NonNullable<ToolPart['providerMetadata']>[string] | undefined {
  if (authoritative && typeof input['toolIdentity'] === 'string') {
    return {
      toolIdentity: input['toolIdentity'],
      ...(typeof input['toolId'] === 'string' ? { toolId: input['toolId'] } : {}),
    };
  }
  return retainInput
    ? Object.fromEntries(
        Object.entries(prior?.providerMetadata?.['brainstrike'] ?? {}).filter(
          ([key]) => key === 'toolIdentity' || key === 'toolId'
        )
      )
    : undefined;
}

/** A call's tool part from a committed tool chunk, keeping the prior part when nothing it shows changed. */
export function projectToolPart(
  prior: ToolPart | undefined,
  input: Readonly<Record<string, unknown>>,
  id: string,
  authoritative: boolean,
  retainInput: boolean
): ToolPart {
  // The user-facing catalog ID when the host committed one; older rows keep
  // the provider-facing name they actually carry.
  const name = [input['toolCatalogId'], input['toolId'], input['toolName']].find(
    (value) => typeof value === 'string'
  );
  if (typeof name !== 'string' && !prior) {
    throw new Error('Committed tool call has no tool name.');
  }
  const argsText =
    retainInput || input['input'] === undefined
      ? (prior?.argsText ?? '')
      : JSON.stringify(input['input']);
  const metadata = mergeProviderMetadata(
    prior?.providerMetadata,
    providerMetadata(input['providerMetadata']),
    toolOwnership(prior, input, authoritative, retainInput)
  );
  const toolName = retainInput
    ? (prior?.toolName ?? '')
    : typeof name === 'string'
      ? name
      : (prior?.toolName ?? '');
  if (
    prior &&
    prior.providerMetadata === metadata &&
    prior.argsText === argsText &&
    prior.toolName === toolName
  ) {
    return prior;
  }
  return {
    ...prior,
    args: argsText === prior?.argsText ? prior.args : (parsePartialJsonObject(argsText) ?? {}),
    argsText,
    ...(metadata ? { providerMetadata: metadata } : {}),
    toolCallId: id,
    toolName,
    type: 'tool-call',
  };
}

/** A call's part with one more live input delta: its input text so far, parsed as far as it reads. */
export function withLiveInputDelta(part: ToolPart, delta: string): ToolPart {
  const argsText = part.argsText + delta;
  return { ...part, args: parsePartialJsonObject(argsText) ?? {}, argsText };
}
