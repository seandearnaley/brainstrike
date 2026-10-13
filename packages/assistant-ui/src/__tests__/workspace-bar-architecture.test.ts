import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBar } from '../workspace-bar/workspace-bar';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath: string): string =>
  readFileSync(join(sourceRoot, relativePath), 'utf8');

const baseBarProps = {
  onAddFolder: vi.fn(),
  onMakePrimary: vi.fn(),
  onRemovePrimary: vi.fn(),
  onRemoveSecondary: vi.fn(),
  onUseFolder: vi.fn(),
  primaryRoot: { displayName: 'app', path: '/work/app', rootId: 'r-1' },
  recentRoots: [],
  secondaryRoots: [],
  workspaceFolders: [],
};

describe('WorkspaceBar architecture', () => {
  it('keeps the mode chip and create dialog as owned workspace-bar modules', () => {
    const workspaceBarSource = readSource('workspace-bar/workspace-bar.tsx');
    expect(workspaceBarSource).toContain("import { ModeChip } from './mode-chip'");
    expect(workspaceBarSource).toContain('<ModeChip');
    expect(readSource('workspace-bar/mode-chip.tsx')).toContain('export const ModeChip');
    expect(readSource('workspace-bar/worktree-create-dialog.tsx')).toContain(
      'export function WorktreeCreateDialog'
    );
  });

  it('keeps the worktree dialogs lexically inside ModeChip JSX', () => {
    const source = readSource('workspace-bar/mode-chip.tsx');
    const modeChipStart = source.indexOf('export const ModeChip');
    const displayNameStart = source.indexOf('ModeChip.displayName');
    expect(modeChipStart).toBeGreaterThan(-1);
    expect(displayNameStart).toBeGreaterThan(modeChipStart);
    expect(source.slice(modeChipStart, displayNameStart)).toContain('<WorktreeCreateDialog');
    expect(source.slice(modeChipStart, displayNameStart)).toContain('<WorktreePickerDialog');
  });

  it('hides the mode chip when the platform omits the capability', () => {
    render(createElement(WorkspaceBar, baseBarProps));
    expect(screen.queryByTestId('workspace-bar-mode-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worktree-picker-dialog')).not.toBeInTheDocument();
  });
});
