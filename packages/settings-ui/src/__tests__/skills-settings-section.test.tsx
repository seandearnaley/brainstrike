/**
 * Settings → Skills panel: master toggle + per-skill enable switches over the
 * capability-gated `window.skills` scan bridge. Invalid skills render their
 * exact validation errors, shadowed skills name their winner, a scan failure
 * renders a DISTINCT error state with Retry (never the empty state), and web
 * (no bridge) shows an honest desktop-only note.
 */

import '@testing-library/jest-dom/vitest';
import {
  __resetSkillsPreferencesStoreForTests,
  useSkillsPreferencesStore,
} from '@brainstrike/app-state/stores/skills-preferences-store';
import type { SkillsScanResultSummary } from '@brainstrike/assistant-contract';
import type { BoundaryTransport } from '@brainstrike/assistant-contract/boundary-result';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillsSettingsSection } from '../settings/system/skills-settings-section';

interface SkillsBridge {
  scan: () => Promise<SkillsScanResultSummary>;
}

function setBridge(bridge: SkillsBridge | undefined): void {
  const host = window as { skills?: BoundaryTransport<SkillsBridge> };
  if (bridge === undefined) {
    Reflect.deleteProperty(host, 'skills');
  } else {
    host.skills = { scan: async () => ({ ok: true, value: await bridge.scan() }) };
  }
}

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
  setBridge(undefined);
});

describe('SkillsSettingsSection', () => {
  it('shows an honest desktop-only note when the bridge is absent (web)', () => {
    setBridge(undefined);
    render(<SkillsSettingsSection />);
    expect(screen.getByTestId('skills-master-toggle')).toBeInTheDocument();
    expect(screen.getByText(/desktop/i)).toBeInTheDocument();
  });

  it('treats a present-but-malformed bridge as absent (shared resolver fails closed)', () => {
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: { scan: 'not-a-function' },
    });
    render(<SkillsSettingsSection />);
    expect(screen.getByText(/desktop/i)).toBeInTheDocument();
  });

  it('lists scanned skills with enable switches and toggling writes the durable key', async () => {
    setBridge({ scan: () => Promise.resolve(SCAN) });
    const user = userEvent.setup();
    render(<SkillsSettingsSection />);

    const toggle = await screen.findByTestId('skill-toggle-root:root-a:pdf-processing');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText('Extract text from PDFs.')).toBeInTheDocument();

    await user.click(toggle);
    expect(useSkillsPreferencesStore.getState().disabledSkillKeys).toEqual({
      'root:root-a:pdf-processing': true,
    });
  });

  it('renders invalid skills with their exact errors and no switch', async () => {
    setBridge({ scan: () => Promise.resolve(SCAN) });
    render(<SkillsSettingsSection />);
    expect(await screen.findByText(/Skill name cannot be empty/)).toBeInTheDocument();
    expect(screen.queryByTestId('skill-toggle-global:broken')).not.toBeInTheDocument();
  });

  it('renders shadowed skills with the winner named', async () => {
    setBridge({ scan: () => Promise.resolve(SCAN) });
    render(<SkillsSettingsSection />);
    expect(await screen.findByText(/shadowed/i)).toBeInTheDocument();
  });

  it('surfaces spec warnings on valid skills', async () => {
    setBridge({ scan: () => Promise.resolve(SCAN) });
    render(<SkillsSettingsSection />);
    expect(await screen.findByText(/600 lines/)).toBeInTheDocument();
  });

  it('master switch writes the store', async () => {
    setBridge({ scan: () => Promise.resolve({ entries: [] }) });
    const user = userEvent.setup();
    render(<SkillsSettingsSection />);
    await user.click(screen.getByTestId('skills-master-toggle'));
    expect(useSkillsPreferencesStore.getState().masterEnabled).toBe(false);
  });

  it('renders a DISTINCT error state with Retry on scan failure (never the empty state)', async () => {
    let calls = 0;
    setBridge({
      scan: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('ipc down')) : Promise.resolve(SCAN);
      },
    });
    const user = userEvent.setup();
    render(<SkillsSettingsSection />);

    expect(await screen.findByTestId('skills-scan-error')).toBeInTheDocument();
    expect(screen.queryByText(/no skills found/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Extract text from PDFs.')).toBeInTheDocument();
  });

  it('shows an honest empty state when the scan finds nothing', async () => {
    setBridge({ scan: () => Promise.resolve({ entries: [] }) });
    render(<SkillsSettingsSection />);
    expect(await screen.findByText(/no skills found/i)).toBeInTheDocument();
  });
});
