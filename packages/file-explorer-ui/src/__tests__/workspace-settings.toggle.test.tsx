import { describe, expect, it, vi } from 'vitest';
import { createInlineFixtureToggleHandler, workspaceSettingsLogger } from '../workspace-settings';

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    isDevEnv: () => true,
  };
});

describe('createInlineFixtureToggleHandler', () => {
  it('logs when persistPatch rejects', async () => {
    const persistPatch = vi.fn().mockRejectedValue(new Error('boom'));
    const onSettingsChange = vi.fn();
    const setDevInlineFixtureEnabled = vi.fn();
    const loggerWarnSpy = vi.spyOn(workspaceSettingsLogger, 'warn').mockImplementation(() => {});

    const handler = createInlineFixtureToggleHandler({
      onSettingsChange,
      persistPatch,
      setDevInlineFixtureEnabled,
    });

    await handler(true);

    expect(onSettingsChange).toHaveBeenCalledWith('devInlineFixtureEnabled', true);
    expect(setDevInlineFixtureEnabled).toHaveBeenCalledWith(true);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'Failed to persist inline fixture toggle',
      expect.objectContaining({ error: expect.any(Error) })
    );

    loggerWarnSpy.mockRestore();
  });
});
