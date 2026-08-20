import '@testing-library/jest-dom/vitest';
import type { PromptItem } from '@brainstrike/db';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PromptBuilderDialog } from '../prompt-workbench-builder-dialog';
import {
  buildPromptModelSettings,
  type PromptDraft,
  type PromptModelSettingsDraft,
} from '../prompt-workbench-shared';

function promptItem(modelSettings: Record<string, unknown>): PromptItem {
  return {
    archivedAt: null,
    content: 'Always cite the exact file and line.',
    createdAt: new Date('2026-07-10T12:00:00Z'),
    description: 'Evidence discipline',
    embeddingError: null,
    embeddingProfileId: 'default',
    embeddingRevision: 1,
    embeddingStatus: 'ready',
    embeddingUpdatedAt: new Date('2026-07-10T12:00:00Z'),
    id: 'item-1',
    isFavorite: false,
    kind: 'prompt',
    lastUsedAction: null,
    lastUsedAt: null,
    modelKey: 'openai::gpt-5.4',
    modelSettings,
    rating: 4,
    revision: 1,
    sourceUrl: null,
    tags: ['evidence'],
    title: 'Evidence rule',
    updatedAt: new Date('2026-07-10T12:00:00Z'),
    useCount: 0,
  };
}

describe('PromptBuilderDialog model settings', () => {
  it('edits every canonical field, preserves other settings, and normalizes maxTokens', async () => {
    const user = userEvent.setup();
    let savedDraft: PromptDraft | undefined;
    const onSave = vi.fn(async (draft: PromptDraft) => {
      savedDraft = draft;
    });
    render(
      <PromptBuilderDialog
        item={promptItem({
          frequencyPenalty: -0.5,
          maxTokens: 2048,
          model: 'gpt-5.4',
          presencePenalty: 0.75,
          temperature: 0.25,
          topP: 0.8,
        })}
        modelOptions={[{ key: 'openai::gpt-5.4', label: 'OpenAI · GPT-5.4' }]}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    await user.click(within(dialog).getByText('Advanced model settings'));
    const inputs = {
      frequencyPenalty: within(dialog).getByRole('spinbutton', { name: 'Frequency penalty' }),
      maxOutputTokens: within(dialog).getByRole('spinbutton', { name: 'Max output tokens' }),
      presencePenalty: within(dialog).getByRole('spinbutton', { name: 'Presence penalty' }),
      temperature: within(dialog).getByRole('spinbutton', { name: 'Temperature' }),
      topP: within(dialog).getByRole('spinbutton', { name: 'Top P' }),
    };
    expect(inputs.temperature).toHaveValue(0.25);
    expect(inputs.topP).toHaveValue(0.8);
    expect(inputs.maxOutputTokens).toHaveValue(2048);
    expect(inputs.frequencyPenalty).toHaveValue(-0.5);
    expect(inputs.presencePenalty).toHaveValue(0.75);

    for (const [input, value] of [
      [inputs.temperature, '0.4'],
      [inputs.topP, '0.9'],
      [inputs.maxOutputTokens, '4096'],
      [inputs.frequencyPenalty, '-0.25'],
      [inputs.presencePenalty, '0.5'],
    ] as const) {
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSettings: {
            frequencyPenalty: '-0.25',
            maxOutputTokens: '4096',
            presencePenalty: '0.5',
            temperature: '0.4',
            topP: '0.9',
          },
        })
      )
    );
    if (!savedDraft) {
      throw new Error('Expected the prompt draft to be saved.');
    }
    expect(
      buildPromptModelSettings(savedDraft.modelSettings, {
        maxTokens: 2048,
        model: 'gpt-5.4',
      })
    ).toEqual({
      frequencyPenalty: -0.25,
      maxOutputTokens: 4096,
      model: 'gpt-5.4',
      presencePenalty: 0.5,
      temperature: 0.4,
      topP: 0.9,
    });
  });

  it('rejects invalid values instead of coercing them', () => {
    const draft: PromptModelSettingsDraft = {
      frequencyPenalty: '',
      maxOutputTokens: '1.5',
      presencePenalty: '',
      temperature: '',
      topP: '',
    };
    expect(() => buildPromptModelSettings(draft, null)).toThrow(
      'Prompt model setting "maxOutputTokens" must be a positive integer.'
    );
  });

  it('surfaces an invalid collapsed setting through the dialog alert', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(draft: PromptDraft) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <PromptBuilderDialog
        item={promptItem({ temperature: 0.25 })}
        modelOptions={[{ key: 'openai::gpt-5.4', label: 'OpenAI · GPT-5.4' }]}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    await user.click(within(dialog).getByText('Advanced model settings'));
    const temperature = within(dialog).getByRole('spinbutton', { name: 'Temperature' });
    await user.clear(temperature);
    await user.type(temperature, '3');
    await user.click(within(dialog).getByText('Advanced model settings'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Prompt model setting "temperature" must be between 0 and 2.'
    );
  });

  it('blocks saving advanced settings after switching to the current thread model', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(draft: PromptDraft) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <PromptBuilderDialog
        item={promptItem({ temperature: 0.25 })}
        modelOptions={[{ key: 'openai::gpt-5.4', label: 'OpenAI · GPT-5.4' }]}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Run with' }), '');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Choose a model or clear the advanced model settings before saving.'
    );
  });

  it('surfaces malformed stored settings and keeps the dialog available for repair', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(draft: PromptDraft) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <PromptBuilderDialog
        item={promptItem({ maxOutputTokens: 4096, maxTokens: 2048, temperature: 'hot' })}
        modelOptions={[{ key: 'openai::gpt-5.4', label: 'OpenAI · GPT-5.4' }]}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Prompt model settings cannot specify both "maxTokens" and "maxOutputTokens".'
    );
    await user.click(within(dialog).getByText('Advanced model settings'));
    expect(within(dialog).getByRole('spinbutton', { name: 'Max output tokens' })).toHaveValue(null);

    await user.type(within(dialog).getByRole('spinbutton', { name: 'Max output tokens' }), '8192');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('makes preserved uneditable settings visible in the advanced section', async () => {
    const user = userEvent.setup();
    render(
      <PromptBuilderDialog
        item={promptItem({ model: 'gpt-5.4', seed: 42 })}
        modelOptions={[{ key: 'openai::gpt-5.4', label: 'OpenAI · GPT-5.4' }]}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit Evidence rule' });
    await user.click(within(dialog).getByText('Advanced model settings'));
    expect(within(dialog).getByText('Preserved uneditable settings')).toBeVisible();
    expect(within(dialog).getByText('model')).toBeVisible();
    expect(within(dialog).getByText('"gpt-5.4"')).toBeVisible();
    expect(within(dialog).getByText('seed')).toBeVisible();
    expect(within(dialog).getByText('42')).toBeVisible();
  });
});
