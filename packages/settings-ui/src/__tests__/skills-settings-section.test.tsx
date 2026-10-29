/**
 * Settings → Skills panel: master toggle + per-skill enable switches over the
 * agent host's skills scan. Invalid skills render their exact validation
 * errors, shadowed skills name their winner, a scan failure renders a DISTINCT
 * error state with Retry (never the empty state), and web (no host scan) shows
 * an honest desktop-only note.
 */

import '@testing-library/jest-dom/vitest';
import {
  __resetSkillsPreferencesStoreForTests,
  useSkillsPreferencesStore,
} from '@brainstrike/app-state/stores/skills-preferences-store';
import type { SkillsScanResultSummary } from '@brainstrike/assistant-contract';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillsSettingsSection } from '../settings/system/skills-settings-section';

const SCAN: SkillsScanResultSummary = {
  entries: [
    {
      absPath: '/proj/.brainstrike/skills/pdf-processing',
      description: 'Extract text from PDFs.',
      dirName: 'pdf-processing',
      name: 'pdf-processing',
      preferenceKey: 'root:root-a:pdf-processing',
      sourceRootDisplayName: 'my-project',
      sourceRootId: 'root-a',
      status: 'ok',
      tier: 'root-brainstrike',
      userInvocable: true,
      warnings: [
        'Instructions have 600 lines (recommended: <500). Consider moving content to references/.',
      ],
    },
    {
      absPath: '/home/user/.claude/skills/broken',
      dirName: 'broken',
      errors: ['name: Skill name cannot be empty'],
      status: 'invalid',
      tier: 'global-claude',
    },
    {
      absPath: '/home/user/.claude/skills/pdf-processing',
      description: 'Older global variant.',
      dirName: 'pdf-processing',
      name: 'pdf-processing',
      preferenceKey: 'global:pdf-processing',
      shadowedBy: { absPath: '/proj/.brainstrike/skills/pdf-processing', tier: 'root-brainstrike' },
      status: 'shadowed',
      tier: 'global-claude',
      userInvocable: true,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  __resetSkillsPreferencesStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe('SkillsSettingsSection', () => {
  it('shows an honest desktop-only note without a host scan (web)', () => {
    render(<SkillsSettingsSection />);
    expect(screen.getByTestId('skills-master-toggle')).toBeInTheDocument();
    expect(screen.getByText(/desktop/iu)).toBeInTheDocument();
  });

  it('lists scanned skills with enable switches and toggling writes the durable key', async () => {
    const user = userEvent.setup();
    render(<SkillsSettingsSection scanSkills={() => Promise.resolve(SCAN)} />);

    const toggle = await screen.findByTestId('skill-toggle-root:root-a:pdf-processing');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText('Extract text from PDFs.')).toBeInTheDocument();

    await user.click(toggle);
    expect(useSkillsPreferencesStore.getState().disabledSkillKeys).toEqual({
      'root:root-a:pdf-processing': true,
    });
  });

  it('renders invalid skills with their exact errors and no switch', async () => {
    render(<SkillsSettingsSection scanSkills={() => Promise.resolve(SCAN)} />);
    expect(await screen.findByText(/Skill name cannot be empty/u)).toBeInTheDocument();
    expect(screen.queryByTestId('skill-toggle-global:broken')).not.toBeInTheDocument();
  });

  it('renders shadowed skills with the winner named', async () => {
    render(<SkillsSettingsSection scanSkills={() => Promise.resolve(SCAN)} />);
    expect(await screen.findByText(/shadowed/iu)).toBeInTheDocument();
  });

  it('surfaces spec warnings on valid skills', async () => {
    render(<SkillsSettingsSection scanSkills={() => Promise.resolve(SCAN)} />);
    expect(await screen.findByText(/600 lines/u)).toBeInTheDocument();
  });

  it('master switch writes the store', async () => {
    const user = userEvent.setup();
    render(<SkillsSettingsSection scanSkills={() => Promise.resolve({ entries: [] })} />);
    await user.click(screen.getByTestId('skills-master-toggle'));
    expect(useSkillsPreferencesStore.getState().masterEnabled).toBe(false);
  });

  it('renders a DISTINCT error state with Retry on scan failure (never the empty state)', async () => {
    let calls = 0;
    const scanSkills = (): Promise<SkillsScanResultSummary> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('host down')) : Promise.resolve(SCAN);
    };
    const user = userEvent.setup();
    render(<SkillsSettingsSection scanSkills={scanSkills} />);

    expect(await screen.findByTestId('skills-scan-error')).toBeInTheDocument();
    expect(screen.queryByText(/no skills found/iu)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/iu }));
    expect(await screen.findByText('Extract text from PDFs.')).toBeInTheDocument();
  });

  it('shows an honest empty state when the scan finds nothing', async () => {
    render(<SkillsSettingsSection scanSkills={() => Promise.resolve({ entries: [] })} />);
    expect(await screen.findByText(/no skills found/iu)).toBeInTheDocument();
  });
});
