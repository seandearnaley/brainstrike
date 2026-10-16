import { describe, expect, it } from 'vitest';

describe('hosted Web agent entrypoint', () => {
  it('exposes request-size configuration without loading the assistant runtime', async () => {
    const requestBoundaryModule = await import('../request-boundary');

    expect(Object.keys(requestBoundaryModule).sort()).toEqual([
      'ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR',
      'AssistantRequestBodyLimitConfigError',
      'DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES',
      'HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES',
      'resolveAssistantRequestBodyLimitBytes',
    ]);
    expect(requestBoundaryModule.resolveAssistantRequestBodyLimitBytes('1024')).toBe(1024);
  });

  it('exports the complete hosted assistant boundary without local inference APIs', async () => {
    const hostedWebModule = await import('../hosted-web');

    expect(typeof hostedWebModule.convertAssistantUiMessagesWithFinalInput).toBe('function');
    expect(typeof hostedWebModule.createStatelessAssistantDataStreamResponse).toBe('function');
    expect(typeof hostedWebModule.hasAssistantPromptContent).toBe('function');
    expect(typeof hostedWebModule.parseAssistantRequestPayloadText).toBe('function');
    expect(typeof hostedWebModule.readRequestBodyText).toBe('function');
    expect(typeof hostedWebModule.readToolApprovalRunConfigAction).toBe('function');
    expect(typeof hostedWebModule.readToolResumeRunConfigAction).toBe('function');
    expect(typeof hostedWebModule.resolveAssistantRequestBodyLimitBytes).toBe('function');
    expect(typeof hostedWebModule.streamHostedWebTurn).toBe('function');
    expect(typeof hostedWebModule.createProvider).toBe('function');
    expect(typeof hostedWebModule.materializeHostProviderModel).toBe('function');
    expect(typeof hostedWebModule.injectWorkspaceRootManifestContext).toBe('function');
    // ADR-0022 retired the agent loop for web; the old entry must be gone so
    // a caller cannot quietly route back through it.
    expect('toAiSdkStyleStream' in hostedWebModule).toBe(false);
    expect(hostedWebModule.HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES).toBe(4 * 1024 * 1024);

    expect('assistantDataStreamSessions' in hostedWebModule).toBe(false);
    expect('LocalLlmBackend' in hostedWebModule).toBe(false);
    expect('createLocalHostEmbeddingModel' in hostedWebModule).toBe(false);
  });

  it('fails loudly instead of running the retired built-in local chat provider', async () => {
    const hostedWebModule = await import('../hosted-web');

    expect(() => hostedWebModule.createProvider('local', undefined, undefined, {})).toThrow(
      'Provider local serves embeddings only'
    );
  });
});
