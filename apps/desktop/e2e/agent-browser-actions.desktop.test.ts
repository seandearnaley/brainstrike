// The agent clicks, types and picks options on its own browser page
// (BST-2324), in the real app against a dev server on this machine. Each
// action asks a person, by the element it names. The hard blocks (BST-2209)
// refuse a password, a card number, a purchase and a CAPTCHA before anything
// reaches the page, and a click that took the tab to an origin nobody approved
// leaves the next action refused (BST-2325). The page reports every input,
// change, click and submit to the server, so "nothing reached the page" is
// read from what the page itself saw.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const TOOLS = {
  click: 'brainstrike_browserClick',
  navigate: 'brainstrike_browserNavigate',
  read: 'brainstrike_browserReadPage',
  select: 'brainstrike_browserSelectOption',
  type: 'brainstrike_browserType',
} as const;
const FINAL = 'Browser actions proof complete.';

function page(otherOrigin: string): string {
  return `<!doctype html><title>BST-2324 form</title>
<label>Name <input id="name"></label>
<label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
<button id="save" type="button">Save</button>
<output id="status"></output>
<form id="login"><label>Email <input id="email" type="email"></label>
  <label>Password <input id="password" type="password"></label></form>
<form id="pay"><label>Card number <input id="card" autocomplete="cc-number"></label>
  <button id="order">Place order</button></form>
<div class="g-recaptcha"><label><input id="robot" type="checkbox"> Not a robot</label></div>
<a id="away" href="${otherOrigin}/away">Elsewhere</a>
<script>
  const report = (kind, target) =>
    fetch('/event', { body: JSON.stringify({ kind, target: target.id || '', value: target.value ?? '' }), method: 'POST' });
  for (const kind of ['input', 'change', 'click', 'submit', 'keydown']) {
    document.addEventListener(kind, (event) => report(kind, event.target), true);
  }
  document.getElementById('pay').addEventListener('submit', (event) => event.preventDefault());
  document.getElementById('save').addEventListener('click', () => {
    const saved = 'saved ' + document.getElementById('name').value + ' ' + document.getElementById('size').value;
    document.getElementById('status').value = saved;
    report('saved', { id: 'status', value: saved });
  });
</script>`;
}

interface PageEvent {
  readonly kind: string;
  readonly target: string;
  readonly value: string;
}

function streaming(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true;
}

/** The ref the latest read gave `role "name"`, from the request's own history. */
function refFor(messages: readonly unknown[], role: string, name: string): string {
  const match = new RegExp(String.raw`${role} \\*"${name}\\*" \[ref=(e\d+)\]`, 'u').exec(
    JSON.stringify(messages)
  );
  return match?.[1] ?? 'e999';
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The waiting step names the element the model gave; approve it. */
async function approve(panel: Locator, step: string, tool: string): Promise<void> {
  await expect(panel.getByRole('button', { name: `${step}, expand details` })).toBeVisible({
    timeout: 60_000,
  });
  await panel
    .getByRole('group', { name: `Tool approval ${tool}` })
    .getByRole('button', { exact: true, name: `Approve ${tool}` })
    .click();
}

test('the agent acts on its own page, and the hard blocks refuse before the page sees anything (BST-2324)', async ({
  modelProvider,
  window,
}) => {
  test.setTimeout(240_000);
  const events: PageEvent[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/event') {
      void body(request).then((text) => {
        events.push(JSON.parse(text) as PageEvent);
        response.writeHead(204).end();
      });
      return;
    }
    const { port } = server.address() as AddressInfo;
    response.writeHead(200, { 'content-type': 'text/html' }).end(page(`http://127.0.0.1:${port}`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://localhost:${port}`;
  try {
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window);
    modelProvider.setScript(({ messages, requestBody }) => {
      if (!streaming(requestBody)) {
        return { finalText: 'Browser actions proof' };
      }
      const ref = (role: string, name: string) => refFor(messages, role, name);
      return {
        finalText: FINAL,
        toolCallStages: [
          [{ arguments: { toolNames: Object.values(TOOLS) }, name: 'load_tool' }],
          [{ arguments: { url: `${origin}/` }, name: TOOLS.navigate }],
          [{ arguments: { filter: 'interactive' }, name: TOOLS.read }],
          [
            {
              arguments: { element: 'Name field', ref: ref('textbox', 'Name'), text: 'Ada' },
              name: TOOLS.type,
            },
          ],
          [
            {
              arguments: { element: 'Size', ref: ref('combobox', 'Size'), values: ['Large'] },
              name: TOOLS.select,
            },
          ],
          [{ arguments: { element: 'Save', ref: ref('button', 'Save') }, name: TOOLS.click }],
          [
            {
              arguments: {
                element: 'Email',
                ref: ref('textbox', 'Email'),
                text: 'ada@example.com',
              },
              name: TOOLS.type,
            },
          ],
          [
            {
              arguments: { element: 'Card', ref: ref('textbox', 'Card number'), text: '4242' },
              name: TOOLS.type,
            },
          ],
          [
            {
              arguments: { element: 'Place order', ref: ref('button', 'Place order') },
              name: TOOLS.click,
            },
          ],
          [
            {
              arguments: { element: 'Not a robot', ref: ref('checkbox', 'Not a robot') },
              name: TOOLS.click,
            },
          ],
          [
            {
              arguments: { element: 'Elsewhere', ref: ref('link', 'Elsewhere') },
              name: TOOLS.click,
            },
          ],
          [{ arguments: { element: 'Save again', ref: ref('button', 'Save') }, name: TOOLS.click }],
        ],
      };
    });
    await ensureAssistantShellVisible(window);
    const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
    await panel.getByRole('textbox', { name: 'Message input' }).fill('Fill in my form.');
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await panel
      .getByRole('group', { name: `Open ${origin}` })
      .getByRole('button', { name: 'Allow once' })
      .click({ timeout: 60_000 });

    // Each action asks, by the element the model named.
    for (const [step, tool] of [
      ['Typing into Name field', 'brainstrike.browserType'],
      ['Selecting Size', 'brainstrike.browserSelectOption'],
      ['Clicking Save', 'brainstrike.browserClick'],
      ['Typing into Email', 'brainstrike.browserType'],
      ['Typing into Card', 'brainstrike.browserType'],
      ['Clicking Place order', 'brainstrike.browserClick'],
      ['Clicking Not a robot', 'brainstrike.browserClick'],
      ['Clicking Elsewhere', 'brainstrike.browserClick'],
      ['Clicking Save again', 'brainstrike.browserClick'],
    ] as const) {
      await approve(panel, step, tool);
    }
    await expect(panel.getByText(FINAL, { exact: true })).toBeVisible({ timeout: 60_000 });

    // The allowed actions reached the page as a person's would.
    await expect
      .poll(() => events.find((event) => event.kind === 'saved')?.value)
      .toBe('saved Ada Large');
    expect(events).toContainEqual({ kind: 'input', target: 'name', value: 'Ada' });
    expect(events).toContainEqual({ kind: 'change', target: 'size', value: 'Large' });

    // The refused ones never did: no event names their elements.
    const requests = JSON.stringify(modelProvider.requests());
    for (const category of ['credential', 'payment', 'purchase', 'captcha']) {
      expect(requests).toContain(`Refused (${category})`);
    }
    for (const target of ['email', 'password', 'card', 'order', 'robot', 'login', 'pay']) {
      expect(
        events.filter((event) => event.target === target),
        target
      ).toEqual([]);
    }

    // The link took the tab to an origin nobody approved: the next action is
    // refused there (BST-2325).
    expect(requests).toContain('origin_not_approved');
    expect(requests).toContain(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
});
