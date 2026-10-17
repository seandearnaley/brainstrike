import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bs-lsp-e2e-')));
const INSPECT = 'brainstrike_lspInspect';
const WRITE = 'brainstrike_writeWorkspaceFile';
test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: root } });
test.afterAll(() => rmSync(root, { force: true, recursive: true }));

test('assistant LSP results refresh after external edits and withhold ignored inferred data', async ({
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  await writeFile(join(root, 'value.ts'), 'export const value: number = 1;\n');
  await writeFile(
    join(root, 'use.ts'),
    'import { value } from "./value";\nconst derived = value;\n'
  );
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByTestId('permission-policy-edit').selectOption('allow');
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const run = async (
    label: string,
    calls: { name: string; arguments: Record<string, unknown> }[]
  ) => {
    const before = modelProvider.requests().length;
    modelProvider.setScript(({ requestBody }) => {
      if (
        !(
          requestBody &&
          typeof requestBody === 'object' &&
          'stream' in requestBody &&
          requestBody.stream === true
        )
      ) {
        return { finalText: 'LSP regression qualification' };
      }
      return {
        finalText: label,
        toolCallStages: [
          [{ arguments: { toolNames: [INSPECT] }, name: 'load_tool' }],
          ...calls.map((call) => [call]),
        ],
      };
    });
    await ensureAssistantShellVisible(window);
    await panel.getByRole('textbox', { name: 'Message input' }).fill(`Run LSP checks: ${label}`);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(panel.getByText(label, { exact: true }).last()).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0, {
      timeout: 60_000,
    });
    return JSON.stringify(
      modelProvider
        .requests()
        .slice(before)
        .flatMap(({ messages }) =>
          messages.filter(
            (message) =>
              message &&
              typeof message === 'object' &&
              (('type' in message && message.type === 'function_call_output') ||
                ('role' in message && message.role === 'tool'))
          )
        )
    );
  };
  const inspect = (file: string, line: number, match: string) => ({
    arguments: { line, match, path: file, root: null },
    name: INSPECT,
  });
  expect(
    await run('Initial types checked.', [
      inspect('value.ts', 1, 'value'),
      inspect('use.ts', 2, 'value'),
    ])
  ).toContain('const value: number');
  await writeFile(join(root, 'value.ts'), 'export const value: string = "current";\n');
  expect(await run('Updated types checked.', [inspect('use.ts', 2, 'value')])).toContain(
    '(alias) const value: string'
  );

  await writeFile(join(root, '.llmignore'), 'value.ts\n');
  await writeFile(
    join(root, 'value.ts'),
    'export const value = "FAKE_E2E_PRIVATE_LITERAL" as const;\n'
  );
  const content =
    'import { value } from "./value";\nconst derived = value;\nconst reject: "public" = derived;\n';
  const requests = await run('Read policy checked.', [
    { arguments: { content, path: 'use.ts', root: null }, name: WRITE },
    inspect('use.ts', 2, 'derived'),
  ]);
  expect(requests).toContain('read-policy');
  expect(requests).toContain('Semantic results withheld');
  expect(requests).not.toContain('FAKE_E2E_PRIVATE_LITERAL');
});
