---
title: "Move Workspace Settings 2026 01 28"
---

# Move Workspace Settings Into Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the workspace settings modal from the file explorer toolbar and migrate its two remaining settings ("Clear stored folders" and "Enable inline fixtures") to the main Settings page under the Factory Reset category.

**Architecture:** Add a new "Clear Stored Folders" section to the Factory Reset settings category. The inline fixtures toggle is a developer-only feature that should also move to a Developer section within Factory Reset. Remove the WorkspaceSettings modal component and update the toolbar to no longer render it.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, Playwright (E2E)

---

## Task 1: Create ClearStoredFoldersPanel Component

**Files:**
- Create: `packages/preferences/src/settings/system/clear-stored-folders-panel.tsx`
- Test: `packages/preferences/src/__tests__/clear-stored-folders-panel.test.tsx`

**Step 1: Write the failing test**

```tsx
// packages/preferences/src/__tests__/clear-stored-folders-panel.test.tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ClearStoredFoldersPanel } from '../settings/system/clear-stored-folders-panel';

describe('ClearStoredFoldersPanel', () => {
  describe('rendering', () => {
    it('renders heading and description', () => {
      render(<ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={vi.fn()} />);

      expect(screen.getByText('Stored Folders')).toBeInTheDocument();
      expect(
        screen.getByText(/Clear all remembered folders for File System access/i)
      ).toBeInTheDocument();
    });

    it('renders clear button', () => {
      render(<ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={vi.fn()} />);

      expect(screen.getByRole('button', { name: /Forget all folders/i })).toBeInTheDocument();
    });

    it('disables button when no stored folders', () => {
      render(<ClearStoredFoldersPanel hasStoredFolders={false} onClearFolders={vi.fn()} />);

      expect(screen.getByRole('button', { name: /Forget all folders/i })).toBeDisabled();
    });

    it('enables button when folders exist', () => {
      render(<ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={vi.fn()} />);

      expect(screen.getByRole('button', { name: /Forget all folders/i })).toBeEnabled();
    });
  });

  describe('interactions', () => {
    it('calls onClearFolders when button clicked', async () => {
      const user = userEvent.setup();
      const onClearFolders = vi.fn();
      render(<ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={onClearFolders} />);

      await user.click(screen.getByRole('button', { name: /Forget all folders/i }));

      expect(onClearFolders).toHaveBeenCalledTimes(1);
    });

    it('does not call onClearFolders when disabled', async () => {
      const user = userEvent.setup();
      const onClearFolders = vi.fn();
      render(<ClearStoredFoldersPanel hasStoredFolders={false} onClearFolders={onClearFolders} />);

      const button = screen.getByRole('button', { name: /Forget all folders/i });
      // Force click on disabled button
      await user.click(button).catch(() => {});

      expect(onClearFolders).not.toHaveBeenCalled();
    });
  });

  describe('visibility', () => {
    it('returns null when isWebPlatform is false', () => {
      const { container } = render(
        <ClearStoredFoldersPanel
          hasStoredFolders={true}
          isWebPlatform={false}
          onClearFolders={vi.fn()}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('renders when isWebPlatform is true', () => {
      render(
        <ClearStoredFoldersPanel
          hasStoredFolders={true}
          isWebPlatform={true}
          onClearFolders={vi.fn()}
        />
      );

      expect(screen.getByText('Stored Folders')).toBeInTheDocument();
    });

    it('renders by default (assumes web)', () => {
      render(<ClearStoredFoldersPanel hasStoredFolders={true} onClearFolders={vi.fn()} />);

      expect(screen.getByText('Stored Folders')).toBeInTheDocument();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/preferences -- clear-stored-folders-panel.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```tsx
// packages/preferences/src/settings/system/clear-stored-folders-panel.tsx
import { Button, Label } from '@brainstrike/ui';

export interface ClearStoredFoldersPanelProps {
  /** Whether stored folders exist in IndexedDB */
  hasStoredFolders: boolean;
  /** Callback to clear all stored folder handles */
  onClearFolders: () => void;
  /** Whether running on web platform (has File System Access API). Defaults to true. */
  isWebPlatform?: boolean;
}

export function ClearStoredFoldersPanel({
  hasStoredFolders,
  onClearFolders,
  isWebPlatform = true,
}: ClearStoredFoldersPanelProps) {
  // Only show on web platform where File System Access API is available
  if (!isWebPlatform) {
    return null;
  }

  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-3">
      <Label className="text-xs">Stored Folders</Label>
      <p className="text-[11px] text-muted-foreground">
        Clear all remembered folders for File System access. This will require you to re-select
        folders next time you use the file explorer.
      </p>
      <Button
        className="mt-1 h-6"
        data-testid="clear-stored-folders-button"
        disabled={!hasStoredFolders}
        onClick={onClearFolders}
        size="sm"
        variant="outline"
      >
        Forget all folders
      </Button>
    </div>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/preferences -- clear-stored-folders-panel.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/preferences/src/settings/system/clear-stored-folders-panel.tsx packages/preferences/src/__tests__/clear-stored-folders-panel.test.tsx
git commit -m "$(cat <<'EOF'
feat(preferences): add ClearStoredFoldersPanel component

Migrating stored folders clearing from workspace settings modal
to the main settings page. This component will be shown only on
web platform where File System Access API is available.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create InlineFixtureSettingsPanel Component

**Files:**
- Create: `packages/preferences/src/settings/system/inline-fixture-settings-panel.tsx`
- Test: `packages/preferences/src/__tests__/inline-fixture-settings-panel.test.tsx`

**Step 1: Write the failing test**

```tsx
// packages/preferences/src/__tests__/inline-fixture-settings-panel.test.tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InlineFixtureSettingsPanel } from '../settings/system/inline-fixture-settings-panel';

describe('InlineFixtureSettingsPanel', () => {
  describe('rendering', () => {
    it('renders heading and description', () => {
      render(
        <InlineFixtureSettingsPanel
          checked={false}
          isAvailable={true}
          isLoading={false}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Developer: Inline Fixtures')).toBeInTheDocument();
      expect(screen.getByText(/Load a built-in test fixture/i)).toBeInTheDocument();
    });

    it('renders switch toggle', () => {
      render(
        <InlineFixtureSettingsPanel
          checked={false}
          isAvailable={true}
          isLoading={false}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('switch')).toBeInTheDocument();
    });

    it('shows checked state correctly', () => {
      render(
        <InlineFixtureSettingsPanel
          checked={true}
          isAvailable={true}
          isLoading={false}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    });

    it('disables switch when loading', () => {
      render(
        <InlineFixtureSettingsPanel
          checked={false}
          isAvailable={true}
          isLoading={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('switch')).toBeDisabled();
    });
  });

  describe('interactions', () => {
    it('calls onChange when toggled', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <InlineFixtureSettingsPanel
          checked={false}
          isAvailable={true}
          isLoading={false}
          onChange={onChange}
        />
      );

      await user.click(screen.getByRole('switch'));

      expect(onChange).toHaveBeenCalledWith(true);
    });
  });

  describe('visibility', () => {
    it('returns null when isAvailable is false', () => {
      const { container } = render(
        <InlineFixtureSettingsPanel
          checked={false}
          isAvailable={false}
          isLoading={false}
          onChange={vi.fn()}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('renders when isAvailable is true', () => {
      render(
        <InlineFixtureSettingsPanel
          checked={false}
          isAvailable={true}
          isLoading={false}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText('Developer: Inline Fixtures')).toBeInTheDocument();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/preferences -- inline-fixture-settings-panel.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```tsx
// packages/preferences/src/settings/system/inline-fixture-settings-panel.tsx
import { Label, Switch } from '@brainstrike/ui';

export interface InlineFixtureSettingsPanelProps {
  /** Whether inline fixtures are enabled */
  checked: boolean;
  /** Whether inline fixtures feature is available (dev mode with adapter support) */
  isAvailable: boolean;
  /** Whether fixture is currently loading/unloading */
  isLoading: boolean;
  /** Callback when toggle state changes */
  onChange: (checked: boolean) => void;
}

export function InlineFixtureSettingsPanel({
  checked,
  isAvailable,
  isLoading,
  onChange,
}: InlineFixtureSettingsPanelProps) {
  // Only show when inline fixtures are available (dev mode)
  if (!isAvailable) {
    return null;
  }

  return (
    <div className="space-y-1 rounded-md border bg-amber-500/10 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col">
          <Label className="text-xs" htmlFor="inline-fixture-settings-toggle">
            Developer: Inline Fixtures
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Load a built-in test fixture into the file explorer without selecting a real folder.
          </p>
        </div>
        <Switch
          aria-label="Enable inline fixtures"
          checked={checked}
          disabled={isLoading}
          id="inline-fixture-settings-toggle"
          onCheckedChange={onChange}
        />
      </div>
    </div>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/preferences -- inline-fixture-settings-panel.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/preferences/src/settings/system/inline-fixture-settings-panel.tsx packages/preferences/src/__tests__/inline-fixture-settings-panel.test.tsx
git commit -m "$(cat <<'EOF'
feat(preferences): add InlineFixtureSettingsPanel component

Migrating inline fixture toggle from workspace settings modal
to the main settings page. This developer feature loads test
fixtures without selecting real folders.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update Factory Reset Settings Section

**Files:**
- Modify: `packages/preferences/src/settings/system/factory-reset-settings-section.tsx`
- Modify: `packages/preferences/src/__tests__/factory-reset-settings-section.test.tsx`

**Step 1: Update the test file**

```tsx
// packages/preferences/src/__tests__/factory-reset-settings-section.test.tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FactoryResetSettingsSection } from '../settings/system/factory-reset-settings-section';

// Mock the sub-panels
vi.mock('../settings/system/factory-reset-panel', () => ({
  FactoryResetPanel: () => <div data-testid="factory-reset-panel">Factory Reset Panel</div>,
}));

vi.mock('../settings/system/clear-stored-folders-panel', () => ({
  ClearStoredFoldersPanel: ({ hasStoredFolders, onClearFolders, isWebPlatform }: {
    hasStoredFolders: boolean;
    onClearFolders: () => void;
    isWebPlatform?: boolean;
  }) => (
    isWebPlatform !== false ? (
      <div data-testid="clear-stored-folders-panel">
        Clear Stored Folders Panel (has: {String(hasStoredFolders)})
        <button onClick={onClearFolders}>Clear</button>
      </div>
    ) : null
  ),
}));

vi.mock('../settings/system/inline-fixture-settings-panel', () => ({
  InlineFixtureSettingsPanel: ({ isAvailable }: { isAvailable: boolean }) => (
    isAvailable ? <div data-testid="inline-fixture-panel">Inline Fixture Panel</div> : null
  ),
}));

describe('FactoryResetSettingsSection', () => {
  describe('rendering', () => {
    it('renders section heading and description', () => {
      render(<FactoryResetSettingsSection />);

      expect(screen.getByRole('heading', { name: 'Factory Reset' })).toBeInTheDocument();
      expect(
        screen.getByText('Wipe application data (files, embeddings, queues) and reset preferences.')
      ).toBeInTheDocument();
    });

    it('renders FactoryResetPanel component', () => {
      render(<FactoryResetSettingsSection />);

      expect(screen.getByTestId('factory-reset-panel')).toBeInTheDocument();
    });

    it('applies correct spacing classes', () => {
      const { container } = render(<FactoryResetSettingsSection />);

      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer.className).toContain('space-y-4');
    });
  });

  describe('structure', () => {
    it('renders heading as h3 with correct styling', () => {
      render(<FactoryResetSettingsSection />);

      const heading = screen.getByRole('heading', { name: 'Factory Reset' });
      expect(heading.tagName).toBe('H3');
      expect(heading.className).toContain('text-lg');
      expect(heading.className).toContain('font-semibold');
    });

    it('renders description with correct styling', () => {
      render(<FactoryResetSettingsSection />);

      const description = screen.getByText(
        'Wipe application data (files, embeddings, queues) and reset preferences.'
      );
      expect(description.tagName).toBe('P');
      expect(description.className).toContain('text-sm');
      expect(description.className).toContain('text-muted-foreground');
    });
  });

  describe('web platform features', () => {
    it('renders ClearStoredFoldersPanel on web', () => {
      render(<FactoryResetSettingsSection isWebPlatform={true} />);

      expect(screen.getByTestId('clear-stored-folders-panel')).toBeInTheDocument();
    });

    it('does not render ClearStoredFoldersPanel on desktop', () => {
      render(<FactoryResetSettingsSection isWebPlatform={false} />);

      expect(screen.queryByTestId('clear-stored-folders-panel')).not.toBeInTheDocument();
    });
  });

  describe('inline fixture features', () => {
    it('renders InlineFixtureSettingsPanel when available', () => {
      render(
        <FactoryResetSettingsSection
          inlineFixtureSetting={{ available: true, loading: false, checked: false, onChange: vi.fn() }}
        />
      );

      expect(screen.getByTestId('inline-fixture-panel')).toBeInTheDocument();
    });

    it('does not render InlineFixtureSettingsPanel when not available', () => {
      render(
        <FactoryResetSettingsSection
          inlineFixtureSetting={{ available: false, loading: false, checked: false, onChange: vi.fn() }}
        />
      );

      expect(screen.queryByTestId('inline-fixture-panel')).not.toBeInTheDocument();
    });

    it('does not render InlineFixtureSettingsPanel when not provided', () => {
      render(<FactoryResetSettingsSection />);

      expect(screen.queryByTestId('inline-fixture-panel')).not.toBeInTheDocument();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/preferences -- factory-reset-settings-section.test.tsx`
Expected: FAIL - new props not supported

**Step 3: Update implementation**

```tsx
// packages/preferences/src/settings/system/factory-reset-settings-section.tsx
import { ClearStoredFoldersPanel } from './clear-stored-folders-panel';
import { FactoryResetPanel } from './factory-reset-panel';
import { InlineFixtureSettingsPanel } from './inline-fixture-settings-panel';

export interface FactoryResetSettingsSectionProps {
  /** Whether running on web platform. Defaults to true. */
  isWebPlatform?: boolean;
  /** Whether stored folders exist */
  hasStoredFolders?: boolean;
  /** Callback to clear stored folders */
  onClearStoredFolders?: () => void;
  /** Inline fixture settings (developer feature) */
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
}

export function FactoryResetSettingsSection({
  isWebPlatform = true,
  hasStoredFolders = false,
  onClearStoredFolders,
  inlineFixtureSetting,
}: FactoryResetSettingsSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-lg">Factory Reset</h3>
        <p className="text-muted-foreground text-sm">
          Wipe application data (files, embeddings, queues) and reset preferences.
        </p>
      </div>
      <FactoryResetPanel />
      <ClearStoredFoldersPanel
        hasStoredFolders={hasStoredFolders}
        isWebPlatform={isWebPlatform}
        onClearFolders={onClearStoredFolders ?? (() => {})}
      />
      {inlineFixtureSetting && (
        <InlineFixtureSettingsPanel
          checked={inlineFixtureSetting.checked}
          isAvailable={inlineFixtureSetting.available}
          isLoading={inlineFixtureSetting.loading}
          onChange={inlineFixtureSetting.onChange}
        />
      )}
    </div>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/preferences -- factory-reset-settings-section.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/preferences/src/settings/system/factory-reset-settings-section.tsx packages/preferences/src/__tests__/factory-reset-settings-section.test.tsx
git commit -m "$(cat <<'EOF'
feat(preferences): integrate workspace settings into Factory Reset section

FactoryResetSettingsSection now accepts:
- isWebPlatform: conditionally show ClearStoredFoldersPanel
- hasStoredFolders + onClearStoredFolders: handle folder clearing
- inlineFixtureSetting: developer feature toggle

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Export New Components from Preferences Package

**Files:**
- Modify: `packages/preferences/src/index.ts`

**Step 1: Add exports**

```tsx
// Add to packages/preferences/src/index.ts
export { ClearStoredFoldersPanel } from './settings/system/clear-stored-folders-panel';
export type { ClearStoredFoldersPanelProps } from './settings/system/clear-stored-folders-panel';
export { InlineFixtureSettingsPanel } from './settings/system/inline-fixture-settings-panel';
export type { InlineFixtureSettingsPanelProps } from './settings/system/inline-fixture-settings-panel';
export type { FactoryResetSettingsSectionProps } from './settings/system/factory-reset-settings-section';
```

**Step 2: Run build to verify exports work**

Run: `pnpm build --filter @brainstrike/preferences`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/preferences/src/index.ts
git commit -m "$(cat <<'EOF'
feat(preferences): export new settings panel components

Export ClearStoredFoldersPanel and InlineFixtureSettingsPanel
for use in app-level settings pages.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update Web App Settings Page

**Files:**
- Modify: `apps/web/src/app/settings/page-content.tsx`
- Modify: `apps/web/src/app/settings/__tests__/page-content.test.tsx`

**Step 1: Update the test file to verify new functionality**

Add test cases for the stored folders functionality being passed to Factory Reset category.

**Step 2: Update implementation**

The web app needs to:
1. Use `useRestoreAccess` hook to get stored folders state
2. Pass props to `createFactoryResetSettingsCategory()` or create a custom render

```tsx
// apps/web/src/app/settings/page-content.tsx
// Add useRestoreAccess import and wire up clearStoredHandles, storedFolders
```

**Step 3: Run tests**

Run: `pnpm test --filter @brainstrike/web -- page-content.test.tsx`

**Step 4: Commit**

```bash
git add apps/web/src/app/settings/page-content.tsx apps/web/src/app/settings/__tests__/page-content.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): integrate stored folders clearing into settings page

Web settings now shows "Clear Stored Folders" in Factory Reset
category, replacing the workspace settings modal functionality.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update Desktop App Settings Page

**Files:**
- Modify: `apps/desktop/src/renderer/components/settings/page-content.tsx`
- Modify: `apps/desktop/src/__tests__/renderer/components/settings/page-content.test.tsx`

**Step 1: Update implementation**

Desktop doesn't need stored folders (Electron has direct file system access), but may want inline fixtures in dev mode.

**Step 2: Run tests**

Run: `pnpm test --filter @brainstrike/desktop -- page-content.test.tsx`

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/components/settings/page-content.tsx apps/desktop/src/__tests__/renderer/components/settings/page-content.test.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): update settings page for workspace settings migration

Desktop settings page updated - stored folders feature is not
applicable (Electron has direct file system access).

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Remove WorkspaceSettings from Toolbar

**Files:**
- Modify: `packages/file-explorer-ui/src/file-explorer-toolbar.tsx`
- Modify: `packages/file-explorer-ui/src/file-explorer-left-panel.tsx`

**Step 1: Update FileExplorerToolbar**

Remove WorkspaceSettings import and rendering. Remove related props.

```tsx
// packages/file-explorer-ui/src/file-explorer-toolbar.tsx
import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';

interface FileExplorerToolbarProps {
  onDirectorySelect: () => Promise<void>;
  isLoading: boolean;
}

const FileExplorerToolbar: React.FC<FileExplorerToolbarProps> = React.memo(
  ({ onDirectorySelect, isLoading }) => (
    <div className="@container flex items-center gap-2 border-b px-2 py-2">
      <Button
        aria-label={FileExplorerStrings.selectRoot}
        className="@[300px]:h-9 h-8 @[300px]:px-3 px-2"
        data-testid="select-root-button"
        disabled={isLoading}
        onClick={onDirectorySelect}
        size="sm"
        variant="outline"
      >
        <Folder className="@[300px]:mr-2 size-4" />
        <span className="@[300px]:inline hidden">{FileExplorerStrings.selectRoot}</span>
      </Button>
    </div>
  )
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
```

**Step 2: Update FileExplorerLeftPanel**

Remove props being passed to toolbar that are no longer needed:
- `filterError`
- `onFilterChange`
- `hasStoredFolders`
- `onForgetStoredFolders`
- `inlineFixtureSetting`

**Step 3: Commit**

```bash
git add packages/file-explorer-ui/src/file-explorer-toolbar.tsx packages/file-explorer-ui/src/file-explorer-left-panel.tsx
git commit -m "$(cat <<'EOF'
refactor(file-explorer-ui): remove WorkspaceSettings from toolbar

Settings button removed from file explorer toolbar. Users now
access these settings via the main Settings page.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Delete WorkspaceSettings Component and Tests

**Files:**
- Delete: `packages/file-explorer-ui/src/workspace-settings.tsx`
- Delete: `packages/file-explorer-ui/src/__tests__/workspace-settings.test.tsx`
- Delete: `packages/file-explorer-ui/src/__tests__/workspace-settings.apply.test.tsx`
- Delete: `packages/file-explorer-ui/src/__tests__/workspace-settings.toggle.test.tsx`
- Modify: `packages/file-explorer-ui/src/index.ts` (remove exports)

**Step 1: Remove exports from index.ts**

```tsx
// Remove these lines from packages/file-explorer-ui/src/index.ts
// export * from './workspace-settings';
// export { default as WorkspaceSettings } from './workspace-settings';
```

**Step 2: Delete the files**

```bash
rm packages/file-explorer-ui/src/workspace-settings.tsx
rm packages/file-explorer-ui/src/__tests__/workspace-settings.test.tsx
rm packages/file-explorer-ui/src/__tests__/workspace-settings.apply.test.tsx
rm packages/file-explorer-ui/src/__tests__/workspace-settings.toggle.test.tsx
```

**Step 3: Commit**

```bash
git add -A packages/file-explorer-ui/
git commit -m "$(cat <<'EOF'
refactor(file-explorer-ui): remove WorkspaceSettings component

Component removed after migrating its functionality to the main
Settings page. Settings now consolidated in one location.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update File Explorer Tests

**Files:**
- Modify: `packages/file-explorer-ui/src/__tests__/file-explorer-left-panel.test.tsx`
- Modify: `packages/file-explorer-ui/src/__tests__/file-explorer-toolbar.test.tsx` (if exists)

**Step 1: Update tests**

Remove references to workspace settings, filter change handlers in toolbar context, etc.

**Step 2: Run tests**

Run: `pnpm test --filter @brainstrike/file-explorer-ui`

**Step 3: Commit**

```bash
git add packages/file-explorer-ui/src/__tests__/
git commit -m "$(cat <<'EOF'
test(file-explorer-ui): update tests for workspace settings removal

Tests updated to reflect simplified toolbar without settings modal.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update E2E Tests (if needed)

**Files:**
- Check: `apps/desktop/e2e/*.test.ts`

**Step 1: Search for any e2e tests referencing workspace settings**

Based on exploration, no e2e tests directly reference the workspace settings modal.

**Step 2: If tests exist, update them**

Update any tests that interact with the settings button in the file explorer toolbar.

**Step 3: Run e2e tests**

Run: `pnpm test:e2e --filter @brainstrike/desktop`

**Step 4: Commit (if changes needed)**

```bash
git add apps/desktop/e2e/
git commit -m "$(cat <<'EOF'
test(desktop): update e2e tests for settings migration

E2E tests updated for workspace settings removal from toolbar.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Final Validation

**Step 1: Run full check pipeline**

```bash
pnpm check
```

This runs: install → lint → build → type-check → test → e2e

**Step 2: Fix any issues**

Address any lint errors, type errors, or test failures.

**Step 3: Final commit (if needed)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: fix validation issues from workspace settings migration

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Summary of Changes

### Files Created:
- `packages/preferences/src/settings/system/clear-stored-folders-panel.tsx`
- `packages/preferences/src/__tests__/clear-stored-folders-panel.test.tsx`
- `packages/preferences/src/settings/system/inline-fixture-settings-panel.tsx`
- `packages/preferences/src/__tests__/inline-fixture-settings-panel.test.tsx`

### Files Modified:
- `packages/preferences/src/settings/system/factory-reset-settings-section.tsx`
- `packages/preferences/src/__tests__/factory-reset-settings-section.test.tsx`
- `packages/preferences/src/index.ts`
- `apps/web/src/app/settings/page-content.tsx`
- `apps/web/src/app/settings/__tests__/page-content.test.tsx`
- `apps/desktop/src/renderer/components/settings/page-content.tsx`
- `apps/desktop/src/__tests__/renderer/components/settings/page-content.test.tsx`
- `packages/file-explorer-ui/src/file-explorer-toolbar.tsx`
- `packages/file-explorer-ui/src/file-explorer-left-panel.tsx`
- `packages/file-explorer-ui/src/index.ts`
- `packages/file-explorer-ui/src/__tests__/file-explorer-left-panel.test.tsx`

### Files Deleted:
- `packages/file-explorer-ui/src/workspace-settings.tsx`
- `packages/file-explorer-ui/src/__tests__/workspace-settings.test.tsx`
- `packages/file-explorer-ui/src/__tests__/workspace-settings.apply.test.tsx`
- `packages/file-explorer-ui/src/__tests__/workspace-settings.toggle.test.tsx`
