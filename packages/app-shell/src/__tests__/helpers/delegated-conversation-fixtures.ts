import type { DelegatedConversationUpdate } from '@brainstrike/assistant-ui';

export function delegatedUpdate(
  child: string,
  hostRunId = 'initial',
  text = child
): Extract<DelegatedConversationUpdate, { readonly identity: unknown }> {
  const parts = [
    { status: { reason: 'stop' as const, type: 'complete' as const }, text, type: 'text' as const },
  ];
  return {
    baseline: {
      hostRunId,
      messages: [
        {
          content: 'Inspect the workspace',
          createdAt: '2026-09-10T00:00:00.000Z',
          id: 'instructions',
          role: 'user',
        },
      ],
      runEvents: [],
      threadId: child,
    },
    identity: {
      childRuntimeRunId: child,
      parentRuntimeRunId: 'parent',
      parentToolCallId: `call-${child}`,
      personaId: 'explore',
    },
    message: {
      content: parts,
      metadata: {
        custom: {},
        steps: [],
        unstable_annotations: [],
        unstable_data: [],
        unstable_state: null,
      },
      parts,
      role: 'assistant',
      status: { type: 'running' },
    },
    messageId: 'native-row',
  };
}
