// BST-1622. Paired test for scripts/desktop-window-broadcast-assertion-guard.mjs.
//
// The guard exists because ~26 desktop test files stub
// `BrowserWindow.getAllWindows: () => []`, and every main -> renderer broadcast
// in apps/desktop is a `for (const window of BrowserWindow.getAllWindows())`
// loop. An empty listing is a perfectly good stub for a test that does not care
// what the renderer was told; it is a silent false green for one that does.
//
// A guard nobody has seen fail is exactly the failure mode it is meant to
// police, so teeth are asserted here three ways, not demonstrated once:
//   1. against the REAL tree with the waiver list emptied — a real repo file
//      (workspace-open-lifecycle.test.ts) must be flagged, which keeps the
//      detector honest as that file evolves;
//   2. against the reconstructed pre-fix shape of the case that motivated the
//      ticket (ipc-mcp-preferences.test.ts before BST-1615 gave it a recording
//      window) — flagged before the fix, clean after it;
//   3. against the shapes most likely to produce a FALSE accusation.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyWindowListingStubs,
  EMPTY_WINDOW_SEND_ASSERTION_WAIVERS,
  findVacuousWindowBroadcastAssertions,
  MIN_DESKTOP_TEST_FILES,
  stripCommentsAndStrings,
} from '../desktop-window-broadcast-assertion-guard.mjs';

const TEST_DIR = 'apps/desktop/src/__tests__';
const WAIVED_FILE = `${TEST_DIR}/main/workspace-open-lifecycle.test.ts`;

async function writeFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'window-broadcast-guard-'));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

const NO_WAIVERS = new Map();

test('real tree: no desktop test asserts on a renderer send with an empty window listing', async () => {
  const { inspectedFileCount, staleWaivers, violations } =
    await findVacuousWindowBroadcastAssertions();

  assert.ok(
    inspectedFileCount >= MIN_DESKTOP_TEST_FILES,
    `Inspected only ${inspectedFileCount} desktop test file(s), below the floor of ` +
      `${MIN_DESKTOP_TEST_FILES}: discovery broke, so a clean verdict here is vacuous.`
  );
  assert.deepEqual(
    staleWaivers,
    [],
    `Stale waiver(s): ${staleWaivers.join(', ')} no longer pair an empty window listing ` +
      'with a send assertion. Remove the entry rather than leaving a waiver that covers ' +
      'nothing.'
  );
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `  - ${v.filePath}:${v.lineNumber} — ${v.reason}`).join('\n')
  );
});

// Teeth, property 1. Without this the test above is indistinguishable from a
// detector that never fires: it asserts an empty list either way.
test('real tree: the waived file IS a violation once its waiver is removed', async () => {
  const { violations } = await findVacuousWindowBroadcastAssertions({ waivers: NO_WAIVERS });

  assert.ok(
    violations.some((violation) => violation.filePath === WAIVED_FILE),
    `Expected ${WAIVED_FILE} to be detected as an empty-listing send assertion once its ` +
      'waiver is dropped. It no longer is, which means either the file changed (delete the ' +
      'waiver entry) or the detector stopped detecting.'
  );
  assert.equal(EMPTY_WINDOW_SEND_ASSERTION_WAIVERS.get(WAIVED_FILE)?.length > 0, true);
});

// Teeth, property 2: the historical case, in the two states BST-1615 moved it
// between. `notifyMcpExtensionPreferences` broadcasts by iterating the listing,
// so with `() => []` this assertion passes even against a build that sends
// nothing at all.
const PREFERENCES_TEST_BEFORE = `import { BrowserWindow } from 'electron';
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
}));

const send = vi.fn();
const rendererWindow = { isDestroyed: () => false, webContents: { send } };

it('notifies the renderer when the extension dials change', async () => {
  await setExtensionPreferences({ apps: false, tasks: true });
  expect(send).toHaveBeenCalledWith('mcp:extensions:updated', { apps: false, tasks: true });
});
`;

const PREFERENCES_TEST_AFTER = `import { BrowserWindow } from 'electron';
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
}));

const send = vi.fn();
const rendererWindow = { isDestroyed: () => false, webContents: { send } };

it('notifies the renderer when the extension dials change', async () => {
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow] as never);
  await setExtensionPreferences({ apps: false, tasks: true });
  expect(send).toHaveBeenCalledWith('mcp:extensions:updated', { apps: false, tasks: true });
});
`;

test('flags the pre-fix shape: empty listing plus an assertion on a send recorder', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/ipc-mcp-preferences.test.ts`]: PREFERENCES_TEST_BEFORE,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].filePath, `${TEST_DIR}/main/ipc-mcp-preferences.test.ts`);
  assert.match(violations[0].reason, /every BrowserWindow\.getAllWindows\(\) stub/);
  assert.match(violations[0].reason, /createRecordingWindow/);
});

test('clears the same file once the listing gets a recording window', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/ipc-mcp-preferences.test.ts`]: PREFERENCES_TEST_AFTER,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.deepEqual(violations, []);
});

test('flags a direct `expect(window.webContents.send)` assertion too', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/broadcast.test.ts`]: `vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
it('does not notify a destroyed window', () => {
  broadcast();
  expect(
    firstWindow.webContents.send
  ).not.toHaveBeenCalled();
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].lineNumber, 6);
});

test('flags an assertion on the array a send recorder pushes into', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/recorder.test.ts`]: `vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
const sentEvents = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => {
      sentEvents.push({ channel, payload });
    },
  },
};
it('publishes the projection', () => {
  publish();
  expect(sentEvents).toContainEqual({ channel: 'mcp:tools:updated', payload: {} });
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.equal(violations.length, 1);
});

test('leaves an empty listing alone when the file asserts nothing about sends', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/boot-order.test.ts`]: `vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
it('registers handlers in order', () => {
  expect(handlers.get('mcp:status:get')).toBeDefined();
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.deepEqual(violations, []);
});

// mcp-elicitation-bridge.test.ts asserts on `window.webContents.send` and names
// getAllWindows only in a comment recording that the bridge deliberately does
// not enumerate it. Reading that comment as a stub would accuse a correct file.
test('a comment that merely names getAllWindows is not a stub', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/elicitation.test.ts`]: `// Consent payloads reach tracked visible-UI windows only; the bridge never
// enumerates BrowserWindow.getAllWindows(): vi.fn(() => []).
it('delivers consent to the tracked window', () => {
  expect(window.webContents.send).toHaveBeenCalledWith('mcp:elicitation:request', payload);
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.deepEqual(violations, []);
});

test('a file with any non-empty listing anywhere is left alone', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/mixed.test.ts`]: `vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
beforeEach(() => {
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
});
it('publishes once a window exists', () => {
  const send = vi.fn();
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isDestroyed: () => false, webContents: { send } },
  ]);
  publish();
  expect(send).toHaveBeenCalledOnce();
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.deepEqual(violations, []);
});

test('a waived file is reported stale once it stops violating', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/reformed.test.ts`]: `vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send } }]) },
}));
it('publishes', () => {
  expect(send).toHaveBeenCalledOnce();
});
`,
  });

  const { staleWaivers, violations } = await findVacuousWindowBroadcastAssertions({
    root,
    waivers: new Map([[`${TEST_DIR}/main/reformed.test.ts`, 'historical reason']]),
  });

  assert.deepEqual(violations, []);
  assert.deepEqual(staleWaivers, [`${TEST_DIR}/main/reformed.test.ts`]);
});

// Found the hard way while writing this guard: the first draft recognised
// recorders only by the hand-rolled `webContents: { send }` literal, so a file
// that adopted createRecordingWindow became INVISIBLE to it. Adopting the
// shared helper must not buy a file an exemption from the rule the helper
// exists to serve.
test('sees a recorder built by createRecordingWindow, through one rename', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/adopted.test.ts`]: `import { createRecordingWindow } from '../helpers/electron-main-test-harness';
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
it('publishes the restored projection', () => {
  const rendererWindow = createRecordingWindow();
  const send = rendererWindow.send;
  resume();
  expect(send).toHaveBeenCalledWith('mcp:config:updated', {});
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.equal(violations.length, 1);
});

test('sees the events array a createRecordingWindow recorder is read through', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/adopted-events.test.ts`]: `import { createRecordingWindow } from '../helpers/electron-main-test-harness';
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
const rendererWindow = createRecordingWindow();
const sentEvents = rendererWindow.events;
it('does not publish before the watcher settles', () => {
  resume();
  expect(sentEvents).not.toContainEqual({ channel: 'mcp:tools:updated', payload: {} });
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.equal(violations.length, 1);
});

// Stated rather than hidden: the guard recognises a send recorder by the
// window-shaped literal it is installed into. A bare `const send = vi.fn()`
// that is asserted on but never given a `webContents` shape anywhere in the
// file is invisible to it. Catching that would mean guessing from an
// identifier's NAME, which trades this blind spot for false accusations
// against every unrelated `send` mock in the tree — a worse deal for a guard
// whose whole job is to stop unearned greens.
test('known blind spot: an orphaned send mock with no window shape is not detected', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/orphan.test.ts`]: `vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
it('notifies', () => {
  const send = vi.fn();
  publish();
  expect(send).not.toHaveBeenCalled();
});
`,
  });

  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });

  assert.deepEqual(violations, []);
});

test('stripCommentsAndStrings keeps a // inside a string literal', () => {
  const stripped = stripCommentsAndStrings(
    "const url = 'https://x.dev'; // trailing\nconst a = 1;"
  );

  assert.ok(!stripped.includes('trailing'));
  assert.ok(stripped.includes('const a = 1;'));
});

test('classifyWindowListingStubs separates empty, non-empty and unreadable stubs', () => {
  const stubs = classifyWindowListingStubs(
    'getAllWindows: vi.fn(() => []),\n' +
      'vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([win]);\n' +
      'getAllWindows: getAllWindowsMock,\n'
  );

  assert.deepEqual(
    stubs.map((stub) => stub.kind),
    ['empty', 'non-empty', 'unknown', 'unknown']
  );
});
