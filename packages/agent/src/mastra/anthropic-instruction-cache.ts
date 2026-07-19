/**
 * Cache-aware instruction composition (BST-587).
 *
 * Anthropic caches strictly by prefix, and the task-list note re-serializes
 * every turn. Keeping it inside one monolithic system string would invalidate
 * the whole cached system+tools prefix whenever the task list mutates. For
 * Anthropic we therefore split instructions into two system messages: the
 * stable block carries an ephemeral cache breakpoint; the volatile block
 * (task-list note) follows it uncached. Every other provider keeps the exact
 * pre-existing joined-string behavior.
 */

export interface SystemMessageWithOptions {
  content: string;
  providerOptions?: { anthropic: { cacheControl: { type: 'ephemeral' } } };
  role: 'system';
}

export type CacheAwareInstructions = string | SystemMessageWithOptions[];

export function composeCacheAwareInstructions(params: {
  provider: string;
  stableText: string;
  volatileText: string | null;
}): CacheAwareInstructions {
  const joined = [params.stableText, params.volatileText]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  if (params.provider !== 'anthropic') {
    return joined;
  }
  if (!params.stableText) {
    // Degenerate: no stable prefix exists, so there is nothing to cache and no
    // reason to diverge from the plain string form. Pinned by test.
    return joined;
  }
  return [
    {
      content: params.stableText,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      role: 'system',
    },
    ...(params.volatileText ? [{ content: params.volatileText, role: 'system' as const }] : []),
  ];
}
