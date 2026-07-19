import { describe, expect, it, vi } from 'vitest';

const { localInferenceImport } = vi.hoisted(() => ({
  localInferenceImport: vi.fn(),
}));

vi.mock('../providers/local', () => {
  localInferenceImport();
  return {
    createLlmHostChatModel: vi.fn(),
    createLocalLanguageModel: vi.fn(),
  };
});

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
    expect(localInferenceImport).not.toHaveBeenCalled();
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
    expect(typeof hostedWebModule.toAiSdkStyleStream).toBe('function');
    expect(hostedWebModule.HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES).toBe(4 * 1024 * 1024);

    expect('assistantDataStreamSessions' in hostedWebModule).toBe(false);
    expect('LocalLlmBackend' in hostedWebModule).toBe(false);
    expect('createLocalLanguageModel' in hostedWebModule).toBe(false);
    expect('createLocalHostEmbeddingModel' in hostedWebModule).toBe(false);
    expect(localInferenceImport).not.toHaveBeenCalled();
  });

  it('fails loudly instead of selecting an unregistered in-process local model', async () => {
    const hostedWebModule = await import('../hosted-web');

    await expect(
      hostedWebModule.toAiSdkStyleStream(
        [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
        { provider: 'local' }
      )
    ).rejects.toThrow(
      'The in-process local model factory is unavailable from this agent entrypoint'
    );
    expect(localInferenceImport).not.toHaveBeenCalled();
  });
});
