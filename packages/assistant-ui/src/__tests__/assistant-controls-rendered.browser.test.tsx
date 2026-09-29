// @boundaries-ignore Browser-only fixture uses the consuming app's real theme to verify rendered geometry and colors; no runtime dependency.
import '../../../../apps/web/src/app/globals.css';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, type Mock, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ControlsMenu } from '../assistant-controls-menu';

const tools = Array.from({ length: 104 }, (_, index) => ({
  description: `Description for tool ${index + 1}`,
  enabled: index % 2 === 0,
  group: index < 36 ? 'Native tools' : 'Linear',
  id: `tool-${index}`,
  label: `Tool ${index + 1}`,
  source: index < 36 ? ('native' as const) : ('mcp' as const),
}));

type ToggleToolMock = Mock<(toolId: string, enabled: boolean) => void>;

function renderControls(onToggleTool: ToggleToolMock = vi.fn()): ToggleToolMock {
  render(
    <div className="flex h-full w-full items-end justify-end p-4">
      <ControlsMenu
        modelName="gpt-5"
        onProviderSettingsChange={vi.fn()}
        providerSettings={{ OpenAI: { agentMaxSteps: 8 } }}
        selectedProvider="OpenAI"
        toolMenu={{ items: tools, onToggleTool }}
      />
    </div>
  );
  return onToggleTool;
}

function bounds(
  element: Element
): Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'> {
  const rect = element.getBoundingClientRect();
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  };
}

afterEach(cleanup);

test.each([375, 1280])(
  'Controls, expanded tools, and limits fit a %ipx viewport',
  async (width) => {
    const previous = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(width, 800);
    try {
      renderControls();
      await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
      const dialog = await screen.findByRole('dialog', { name: 'Assistant controls' });
      expect(bounds(dialog).left).toBeGreaterThanOrEqual(0);
      expect(bounds(dialog).right).toBeLessThanOrEqual(width);
      expect(bounds(dialog).bottom).toBeLessThanOrEqual(800);

      await userEvent.click(screen.getByText('Native tools'));
      const firstSwitch = screen.getByRole('switch', { name: 'Tool 1 enabled' });
      firstSwitch.scrollIntoView();
      expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);
      expect(bounds(dialog).height).toBeLessThanOrEqual(640);
      expect(bounds(firstSwitch).left).toBeGreaterThanOrEqual(bounds(dialog).left);
      expect(bounds(firstSwitch).right).toBeLessThanOrEqual(bounds(dialog).right);

      await userEvent.click(screen.getByText('Output & Limits', { selector: 'summary span' }));
      const output = await screen.findByRole('spinbutton', { name: 'Output token limit' });
      output.scrollIntoView();
      expect(bounds(output).left).toBeGreaterThanOrEqual(bounds(dialog).left);
      expect(bounds(output).right).toBeLessThanOrEqual(bounds(dialog).right);
      for (const field of dialog.querySelectorAll('input[type="number"], [role="switch"]')) {
        if (bounds(field).width === 0) {
          continue;
        }
        expect(bounds(field).left).toBeGreaterThanOrEqual(bounds(dialog).left);
        expect(bounds(field).right).toBeLessThanOrEqual(bounds(dialog).right);
      }
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    } finally {
      await page.viewport(previous.width, previous.height);
    }
  },
  30_000
);

test('search finds tools across groups and the switch works by keyboard', async () => {
  const onToggleTool = renderControls();
  await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
  const search = await screen.findByRole('searchbox', { name: 'Search tools' });
  await userEvent.type(search, 'tool 12');
  expect(screen.getByRole('switch', { name: 'Tool 12 enabled' })).toBeVisible();
  expect(screen.queryByRole('switch', { name: 'Tool 1 enabled' })).toBeNull();
  const toolSwitch = screen.getByRole('switch', { name: 'Tool 12 enabled' });
  toolSwitch.focus();
  await userEvent.keyboard(' ');
  expect(onToggleTool).toHaveBeenCalledWith('tool-11', true);
  expect(screen.getByRole('button', { name: 'About Tool 12' })).toBeVisible();
  await userEvent.clear(search);
  await userEvent.type(search, 'tool 104');
  const lastSwitch = screen.getByRole('switch', { name: 'Tool 104 enabled' });
  lastSwitch.scrollIntoView();
  const dialog = screen.getByRole('dialog', { name: 'Assistant controls' });
  expect(bounds(lastSwitch).left).toBeGreaterThanOrEqual(bounds(dialog).left);
  expect(bounds(lastSwitch).right).toBeLessThanOrEqual(bounds(dialog).right);
  expect(bounds(lastSwitch).bottom).toBeLessThanOrEqual(bounds(dialog).bottom);
});
