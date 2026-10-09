import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_CONTEXT = 'USER-PROMPT-HOOK-CONTEXT-1789';
const TOOL_CONTEXT = 'POST-TOOL-HOOK-CONTEXT-1789';
const FINAL = 'Read the notes.';
const echo = (stdout: unknown) => `printf '%s\\n' '${JSON.stringify(stdout)}'`;

// The global hooks file is `$HOME/.brainstrike/hooks.json`; the Stop hook
// records its stdin beside it so the spec can read what the hook was given.
const home = mkdtempSync(join(tmpdir(), 'bs-e2e-lifecycle-hooks-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-lifecycle-hooks-root-'));
const stopInput = join(home, 'stop-input.json');
mkdirSync(join(home, '.brainstrike'));
writeFileSync(join(workspace, 'notes.txt'), 'lifecycle notes\n');
writeFileSync(
  join(home, '.brainstrike', 'hooks.json'),
  JSON.stringify({
    PostToolUse: [
      {
        command: echo({ additionalContext: TOOL_CONTEXT }),
        matcher: { tool_name: '^brainstrike\\.readWorkspaceFile$' },
        type: 'command',
      },
    ],
    Stop: [
      {
        command: `cat > '${stopInput}'; ${echo({ brainstrikeRunVerdict: { verdict: 'succeeded' } })}`,
        type: 'command',
      },
    ],
    UserPromptSubmit: [{ command: echo({ additionalContext: PROMPT_CONTEXT }), type: 'command' }],
  })
);

test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace, HOME: home } });
test.afterAll(() => {
  rmSync(home, { force: true, recursive: true });
  rmSync(workspace, { force: true, recursive: true });
});

/** A host run's UserPromptSubmit, PostToolUse and Stop hooks run, and the model reads their context. */
test('a host run’s lifecycle hooks add context the model reads, and Stop sees how it ended', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: FINAL,
          toolCall: { arguments: { path: 'notes.txt' }, name: 'brainstrike_readWorkspaceFile' },
        }
      : { finalText: 'Lifecycle hooks check' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Read notes.txt');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  const [first, second] = modelProvider.requests().filter(({ toolNames }) => toolNames.length > 0);
  // UserPromptSubmit's context is part of every step's instructions.
  expect(JSON.stringify(first?.requestBody)).toContain(PROMPT_CONTEXT);
  expect(JSON.stringify(second?.requestBody)).toContain(PROMPT_CONTEXT);
  // PostToolUse's context reaches the model beside the read's result.
  expect(JSON.stringify(first?.requestBody)).not.toContain(TOOL_CONTEXT);
  expect(JSON.stringify(second?.messages)).toContain(TOOL_CONTEXT);
  expect(JSON.stringify(second?.messages)).toContain('lifecycle notes');

  // The Stop hook ran at the run's end with how it ended and its final answer.
  await expect.poll(() => readFile(stopInput, 'utf8').catch(() => '')).toContain('"Stop"');
  const stop = JSON.parse(await readFile(stopInput, 'utf8')) as Record<string, unknown>;
  expect(stop).toMatchObject({ hook_event_name: 'Stop', stop_reason: 'complete' });
  expect(stop['assistant_message']).toContain(FINAL);
  expect(modelProvider.refusals()).toEqual([]);
});
