// @boundaries-ignore Browser-only test loads the consuming app theme for real Controls interaction.
import '../../../../apps/web/src/app/globals.css';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ControlsMenu } from '../assistant-controls-menu';

afterEach(cleanup);

function renderControls(): {
  onOpenSettings: ReturnType<typeof vi.fn>;
  onProviderSettingsChange: ReturnType<typeof vi.fn>;
} {
  const onProviderSettingsChange = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <div>
      <button type="button">Outside</button>
      <ControlsMenu
        modelName="gpt-5"
        onProviderSettingsChange={onProviderSettingsChange}
        providerSettings={{ OpenAI: { agentMaxSteps: 8 } }}
        selectedProvider="OpenAI"
        toolMenu={{
          items: [
            {
              description: 'A long description that can be read on demand.',
              enabled: true,
              group: 'Native tools',
              id: 'native-read',
              label: 'Read File',
              source: 'native',
            },
          ],
          onOpenSettings,
          onToggleTool: vi.fn(),
        }}
      />
    </div>
  );
  return { onOpenSettings, onProviderSettingsChange };
}

async function openControlsAndLimits(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
  await userEvent.click(screen.getByText('Output & Limits', { selector: 'summary span' }));
  return screen.getByRole('spinbutton', { name: 'Max steps' });
}

test('tool help opens on click and keeps Controls available', async () => {
  renderControls();
  await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
  await userEvent.click(screen.getByText('Native tools', { selector: 'summary span' }));
  const help = screen.getByRole('button', { name: 'About Read File' });
  expect(screen.queryByText('A long description that can be read on demand.')).toBeNull();

  await userEvent.click(help);
  expect(help).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('A long description that can be read on demand.')).toBeVisible();
  expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();

  await userEvent.click(help);
  help.focus();
  await userEvent.keyboard('{Enter}');
  expect(help).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('A long description that can be read on demand.')).toBeVisible();
});

test('Manage tools commits a valid draft and closes Controls before navigating', async () => {
  const { onOpenSettings, onProviderSettingsChange } = renderControls();
  const steps = await openControlsAndLimits();
  await userEvent.clear(steps);
  await userEvent.keyboard('64');
  await userEvent.click(screen.getByRole('button', { name: 'Manage tools…' }));

  expect(onProviderSettingsChange).toHaveBeenCalledWith('OpenAI', { agentMaxSteps: 64 });
  expect(onOpenSettings).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog', { name: 'Assistant controls' })).toBeNull();
});

test('Manage tools refuses an invalid draft; Escape closes without leaving a stale dismissal', async () => {
  const { onOpenSettings, onProviderSettingsChange } = renderControls();
  const steps = await openControlsAndLimits();
  await userEvent.clear(steps);
  await userEvent.keyboard('0');
  await userEvent.click(screen.getByRole('button', { name: 'Manage tools…' }));

  expect(onOpenSettings).not.toHaveBeenCalled();
  expect(onProviderSettingsChange).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();
  expect(screen.getByRole('alert').textContent).toContain('Enter a whole number of steps');

  screen.getByRole('searchbox', { name: 'Search tools' }).focus();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Assistant controls' })).toBeNull();

  const reopened = await openControlsAndLimits();
  await userEvent.clear(reopened);
  await userEvent.keyboard('12');
  await userEvent.click(screen.getByRole('button', { name: 'Outside' }));
  expect(onProviderSettingsChange).toHaveBeenCalledWith('OpenAI', { agentMaxSteps: 12 });
  expect(screen.queryByRole('dialog', { name: 'Assistant controls' })).toBeNull();
});
