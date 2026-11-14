/**
 * ADR-0040: Anthropic's memory tool (`memory_20250818`) as the provider's own
 * declaration of the host's project memory tool.
 *
 * Anthropic's memory tool is executed by the client: the API sends the six
 * file commands and the client runs them. So the declaration wraps the
 * host's own executor and model output, and every call still passes Core's
 * permission decision and dispatch. The AI SDK sends it as
 * `{ name: 'memory', type: 'memory_20250818' }` whatever the tool set's key,
 * and maps a call named `memory` back to that key. Every other provider gets
 * the same commands as the catalog's function tool.
 */
import { anthropic } from '@ai-sdk/anthropic';
import type { ToolSet } from 'ai';

/** Providers whose own memory tool type the host declares. */
const NATIVE_MEMORY_PROVIDERS: ReadonlySet<string> = new Set(['anthropic']);

export function providerSupportsNativeMemory(provider: string): boolean {
  return NATIVE_MEMORY_PROVIDERS.has(provider);
}

/** The provider's memory tool type over the host tool's executor. */
export function createProviderNativeMemoryTool(host: ToolSet[string]): ToolSet[string] {
  const { execute, toModelOutput } = host;
  if (!execute) {
    throw new Error('The memory tool declaration needs the host executor');
  }
  return anthropic.tools.memory_20250818({
    execute: (input, options) => execute(input, options),
    ...(toModelOutput ? { toModelOutput } : {}),
  });
}
