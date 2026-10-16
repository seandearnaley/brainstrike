/**
 * Live QA 2026-10-16 (OpenRouter GLM/Muse/Qwen): activity rows that named a
 * raw id, showed memory markdown as a target, called a create an update,
 * claimed a declined call ran, and hid a failure's reason.
 */
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeAll, expect, it } from 'vitest';
import { ToolFallback } from '../tool-fallback';
import { type LooseProps, toolPartElement } from './tool-part-render';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

function renderTool(props: LooseProps<ComponentProps<typeof ToolFallback>>) {
  return render(
    <TooltipProvider>
      {toolPartElement(ToolFallback, { toolCallId: 'call-1', ...props })}
    </TooltipProvider>
  );
}

const row = () => screen.getByTestId('activity-step-row');
const targetChip = () => row().querySelector('.bs-step-row-target');

it('names a working-memory update by what it did, with no markdown and no raw id as its target', () => {
  const memory = '# Session\n- **Active task**: ship the activity-row fix';
  renderTool({
    args: { memory },
    argsText: JSON.stringify({ memory }),
    result: { success: true },
    status: { type: 'complete' },
    toolName: 'updateWorkingMemory',
  });
  expect(row()).toHaveTextContent('Updated memory');
  expect(row()).not.toHaveTextContent('Used updateWorkingMemory');
  expect(targetChip()).toBeNull();
});

it('names a tool load by the tool it loaded', () => {
  renderTool({
    args: { toolName: 'brainstrike_manageWorktree' },
    argsText: '{"toolName":"brainstrike_manageWorktree"}',
    result: { loaded: ['brainstrike_manageWorktree'] },
    status: { type: 'complete' },
    toolName: 'load_tool',
  });
  expect(row()).toHaveTextContent('Loaded tool');
  expect(targetChip()).toHaveTextContent('brainstrike_manageWorktree');
});

it('reads a canvas create as a create, named by its title rather than its HTML', () => {
  const args = { action: 'create', html: '<h1>Release plan</h1>', title: 'Release plan' };
  renderTool({
    args,
    argsText: JSON.stringify(args),
    result: { canvasId: 'cv-1', version: 1 },
    status: { type: 'complete' },
    toolName: 'brainstrike.manageCanvas',
  });
  expect(row()).toHaveTextContent('Created canvas');
  expect(row()).not.toHaveTextContent('Updated canvas');
  expect(targetChip()).toHaveTextContent('Release plan');
});

it('never says a declined call ran: it names the action that was asked for', () => {
  renderTool({
    args: { path: '.' },
    argsText: '{"path":"."}',
    result: {
      kind: 'declined',
      message: 'The user declined this tool call, so it was not executed.',
    },
    status: { type: 'complete' },
    toolName: 'brainstrike.runSkillScript',
  });
  expect(row()).toHaveTextContent('Run skill script');
  expect(row()).not.toHaveTextContent('Ran skill script');
  expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
});

it('keeps the past tense for a call that was cut off mid-run', () => {
  renderTool({
    args: { command: 'sleep 60' },
    argsText: '{"command":"sleep 60"}',
    status: { reason: 'cancelled', type: 'incomplete' },
    toolName: 'brainstrike.executeCommand',
  });
  expect(row()).toHaveTextContent('Ran');
  expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
});

it('says why a call failed on its collapsed row, from the SDK tool-error the result carries', () => {
  const reason =
    'Invalid input for tool brainstrike.runSkillScript: Must be a canonical root-relative path without traversal';
  renderTool({
    args: { path: '/etc' },
    argsText: '{"path":"/etc"}',
    isError: true,
    result: reason,
    status: { type: 'complete' },
    toolName: 'brainstrike.runSkillScript',
  });
  const chip = screen.getByTestId('tool-failure-reason');
  // Bounded on the row, whole in its tooltip and in the line beneath it.
  expect(chip.textContent?.startsWith('· Invalid input for tool brainstrike.runSkillScript')).toBe(
    true
  );
  expect(chip.textContent?.endsWith('…')).toBe(true);
  expect(chip).toHaveAttribute('title', reason);
  expect(screen.getByText(reason)).toBeInTheDocument();
  expect(screen.queryByText('Tool execution failed.')).toBeNull();
});

it('adds no reason chip when a failure states nothing beyond the failed glyph', () => {
  renderTool({
    args: { path: 'a.md' },
    argsText: '{"path":"a.md"}',
    isError: true,
    result: { name: 'ToolInputError' },
    status: { type: 'complete' },
    toolName: 'brainstrike.readWorkspaceFile',
  });
  expect(screen.queryByTestId('tool-failure-reason')).toBeNull();
  expect(screen.getByText('Tool execution failed.')).toBeInTheDocument();
});
