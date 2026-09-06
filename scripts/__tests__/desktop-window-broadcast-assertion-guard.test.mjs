// BST-1622. Paired test for scripts/desktop-window-broadcast-assertion-guard.mjs.
//
// The guard exists because ~26 desktop test files stub
// `BrowserWindow.getAllWindows: () => []`, and the main -> renderer broadcasts
// it covers are all `for (const window of BrowserWindow.getAllWindows())`
// loops. An empty listing is a perfectly good stub for a test that does not
// care what the renderer was told; it is a silent false green for one that
// does.
//
// It is NOT every send site in apps/desktop (BST-1624): broadcasts that go to
// a WebContents the caller already holds are outside the rule by design, for
// the reason recorded in the registry-routed blind-spot test below. Stated
// here as well as in the guard because this file is read as the guard's
// contract, and a scope claim left stale in one copy is how the next audit
// concludes a path is covered when it is not.
//
// A guard nobody has seen fail is exactly the failure mode it is meant to
// police, so teeth are asserted here rather than demonstrated once:
//   1. against the REAL tree with the waiver list emptied — a real repo file
//      (workspace-open-lifecycle.test.ts) must be flagged, which keeps the
//      detector honest as that file evolves;
//   2. against the reconstructed pre-fix shape of the case that motivated the
//      ticket — flagged before the fix, clean after it.
//
// The other half of the job is NOT accusing correct files. A guard that fails a
// correct test trains people to add waivers, and a waiver list that grows on
// noise is how a guard stops meaning anything. The `## precision` block below
// pins one fixture per false-positive class found in review of #2951, each
// paired with the vacuous twin that must still trip — the "both directions"
// requirement. Every one of those four was reproduced against the pre-review
// implementation before being fixed.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyWindowListingStubs,
  collectSendRecorders,
  EMPTY_WINDOW_SEND_ASSERTION_WAIVERS,
  findRendererSendAssertions,
  findVacuousWindowBroadcastAssertions,
  MIN_DESKTOP_TEST_FILES,
} from '../desktop-window-broadcast-assertion-guard.mjs';

const TEST_DIR = 'apps/desktop/src/__tests__';
const WAIVED_FILE = `${TEST_DIR}/main/workspace-open-lifecycle.test.ts`;
const NO_WAIVERS = new Map();

async function writeFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'window-broadcast-guard-'));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

/** Violations for a single fixture file, with waivers disabled. */
async function violationsFor(name, contents) {
  const root = await writeFixture({ [`${TEST_DIR}/main/${name}`]: contents });
  const { violations } = await findVacuousWindowBroadcastAssertions({ root, waivers: NO_WAIVERS });
  return violations;
}

const EMPTY_LISTING_MOCK = `vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));`;

// ## real tree

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

// Teeth. Without this the test above is indistinguishable from a detector that
// never fires: it asserts an empty list either way.
test('real tree: the waived file IS a violation once its waiver is removed', async () => {
  const { violations } = await findVacuousWindowBroadcastAssertions({ waivers: NO_WAIVERS });

  assert.ok(
    violations.some((violation) => violation.filePath === WAIVED_FILE),
    `Expected ${WAIVED_FILE} to be detected as an empty-listing send assertion once its ` +
      'waiver is dropped. It no longer is, which means either the file changed (delete the ' +
      'waiver entry) or the detector stopped detecting.'
  );
  assert.ok(EMPTY_WINDOW_SEND_ASSERTION_WAIVERS.get(WAIVED_FILE).length > 0);
});

// ## the motivating case, in the two states BST-1615 moved it between
//
// `notifyMcpExtensionPreferences` broadcasts by iterating the listing, so with
// `() => []` this assertion passes even against a build that sends nothing.

const PREFERENCES_TEST_BEFORE = `import { BrowserWindow } from 'electron';
${EMPTY_LISTING_MOCK}

const send = vi.fn();
const rendererWindow = { isDestroyed: () => false, webContents: { send } };

it('notifies the renderer when the extension dials change', async () => {
  await setExtensionPreferences({ apps: false, tasks: true });
  expect(send).toHaveBeenCalledWith('mcp:extensions:updated', { apps: false, tasks: true });
});
`;

const PREFERENCES_TEST_AFTER = `import { BrowserWindow } from 'electron';
${EMPTY_LISTING_MOCK}

const send = vi.fn();
const rendererWindow = { isDestroyed: () => false, webContents: { send } };

it('notifies the renderer when the extension dials change', async () => {
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([rendererWindow] as never);
  await setExtensionPreferences({ apps: false, tasks: true });
  expect(send).toHaveBeenCalledWith('mcp:extensions:updated', { apps: false, tasks: true });
});
`;

test('flags the pre-fix shape: empty listing plus an assertion on a send recorder', async () => {
  const violations = await violationsFor('ipc-mcp-preferences.test.ts', PREFERENCES_TEST_BEFORE);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].filePath, `${TEST_DIR}/main/ipc-mcp-preferences.test.ts`);
  assert.match(violations[0].reason, /every BrowserWindow\.getAllWindows\(\) stub/);
  assert.match(violations[0].reason, /createRecordingWindow/);
});

test('clears the same file once the listing gets a recording window', async () => {
  assert.deepEqual(await violationsFor('ipc-mcp-preferences.test.ts', PREFERENCES_TEST_AFTER), []);
});

// ## detection shapes

test('flags a direct `expect(window.webContents.send)` assertion too', async () => {
  const violations = await violationsFor(
    'broadcast.test.ts',
    `${EMPTY_LISTING_MOCK}
it('does not notify a destroyed window', () => {
  broadcast();
  expect(
    firstWindow.webContents.send
  ).not.toHaveBeenCalled();
});
`
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].lineNumber, 6);
});

test('flags an assertion on the array a send recorder records into', async () => {
  const violations = await violationsFor(
    'recorder.test.ts',
    `${EMPTY_LISTING_MOCK}
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
`
  );

  assert.equal(violations.length, 1);
});

// Found the hard way while writing this guard: the first draft recognised
// recorders only by the hand-rolled `webContents: { send }` literal, so a file
// that adopted createRecordingWindow became INVISIBLE to it. Adopting the shared
// helper must not buy a file an exemption from the rule the helper serves.
test('sees a recorder built by createRecordingWindow, through one rename', async () => {
  const violations = await violationsFor(
    'adopted.test.ts',
    `import { createRecordingWindow } from '../helpers/electron-main-test-harness';
${EMPTY_LISTING_MOCK}
it('publishes the restored projection', () => {
  const rendererWindow = createRecordingWindow();
  const send = rendererWindow.send;
  resume();
  expect(send).toHaveBeenCalledWith('mcp:config:updated', {});
});
`
  );

  assert.equal(violations.length, 1);
});

test('sees the events array a createRecordingWindow recorder is read through', async () => {
  const violations = await violationsFor(
    'adopted-events.test.ts',
    `import { createRecordingWindow } from '../helpers/electron-main-test-harness';
${EMPTY_LISTING_MOCK}
const rendererWindow = createRecordingWindow();
const sentEvents = rendererWindow.events;
it('does not publish before the watcher settles', () => {
  resume();
  expect(sentEvents).not.toContainEqual({ channel: 'mcp:tools:updated', payload: {} });
});
`
  );

  assert.equal(violations.length, 1);
});

// ## precision — one fixture per false-positive class found in review of #2951,
// each paired with the vacuous twin that must still trip.

// Review 3922920484. Adding the recording-window OBJECT to the recorder set made
// every assertion on it look like a send assertion, so a valid test that
// inspects non-send state was rejected. Only send-BEARING members count now.
test('an assertion on a recording window’s non-send state is not a send assertion', async () => {
  const violations = await violationsFor(
    'non-send-state.test.ts',
    `import { createRecordingWindow } from '../helpers/electron-main-test-harness';
${EMPTY_LISTING_MOCK}
it('models a destroyed window', () => {
  const rendererWindow = createRecordingWindow({ destroyed: true });
  expect(rendererWindow.isDestroyed()).toBe(true);
  expect(rendererWindow.id).toBe(1);
});
`
  );

  assert.deepEqual(violations, []);
});

test('…but a send-bearing member of that same window still trips', async () => {
  const violations = await violationsFor(
    'send-member.test.ts',
    `import { createRecordingWindow } from '../helpers/electron-main-test-harness';
${EMPTY_LISTING_MOCK}
it('publishes', () => {
  const rendererWindow = createRecordingWindow();
  publish();
  expect(rendererWindow.payloadsFor('mcp:tools:updated')).toEqual([{}]);
});
`
  );

  assert.equal(violations.length, 1);
});

// Review 3922920494. An ordinary reference to the mock used to classify as
// 'unknown', which made `every(=== 'empty')` false and silently exempted an
// otherwise-vacuous file. A reference is not a stub and must not participate.
test('an ordinary reference to the listing mock does not exempt a vacuous file', async () => {
  const violations = await violationsFor(
    'reference-bypass.test.ts',
    `${EMPTY_LISTING_MOCK}
const send = vi.fn();
const win = { isDestroyed: () => false, webContents: { send } };
it('does not notify', () => {
  broadcast();
  expect(BrowserWindow.getAllWindows).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
`
  );

  assert.equal(violations.length, 1);
});

// Review 3922927764. The scanner keyed off the bare token then took ANY `[`
// within ~90 characters as the stub's value, so a real non-empty stub whose
// value is a variable was read as empty and a correct file was accused.
test('a real stub whose value is a variable is unknown, not empty', async () => {
  const stubs = classifyWindowListingStubs(
    'vi.mocked(BrowserWindow.getAllWindows).mockReturnValue(windows as never);\n' +
      'expect(sentEvents).toEqual([]);'
  );

  assert.deepEqual(
    stubs.map((stub) => stub.kind),
    ['unknown']
  );
});

test('a correct file installing a real window is not accused', async () => {
  const violations = await violationsFor(
    'real-window.test.ts',
    `vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn() } }));
it('publishes', () => {
  const send = vi.fn();
  const windows = [{ isDestroyed: () => false, webContents: { send } }];
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue(windows as never);
  expect(sentEvents).toEqual([]);
  expect(send).toHaveBeenCalledOnce();
});
`
  );

  assert.deepEqual(violations, []);
});

test('an assertion ON the listing mock is not counted as a stub', () => {
  assert.deepEqual(
    classifyWindowListingStubs(
      'expect(electronMainMock.BrowserWindow.getAllWindows()).toEqual([]);'
    ),
    []
  );
});

// Review 3922929693. A quote inside a regex literal desynchronised the
// hand-rolled scanner for the REST of the file, blanking stubs and `expect(`
// sites alike — wrong in both directions, with no bail-out. The parser owns
// lexing now, so regex literals, template literals and comments cost nothing.
test('a quote inside a regex literal does not desynchronise the parse', async () => {
  const violations = await violationsFor(
    'regex-literal.test.ts',
    `${EMPTY_LISTING_MOCK}
const key = raw.replace(/['"]/g, '');
const send = vi.fn();
const win = { isDestroyed: () => false, webContents: { send } };
it('does not notify', () => {
  broadcast();
  expect(send).not.toHaveBeenCalled();
});
`
  );

  assert.equal(violations.length, 1);
});

test('a regex literal does not hide a real non-empty listing either', async () => {
  const violations = await violationsFor(
    'regex-literal-clean.test.ts',
    `${EMPTY_LISTING_MOCK}
const key = raw.replace(/['"]/g, '');
const send = vi.fn();
it('notifies', () => {
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isDestroyed: () => false, webContents: { send } },
  ]);
  broadcast();
  expect(send).toHaveBeenCalledOnce();
});
`
  );

  assert.deepEqual(violations, []);
});

test('a template literal containing braces and quotes does not confuse the parse', async () => {
  const violations = await violationsFor(
    'template-literal.test.ts',
    `${EMPTY_LISTING_MOCK}
const label = \`window: \${id} "quoted" 'single' { webContents: { send } }\`;
const send = vi.fn();
const win = { isDestroyed: () => false, webContents: { send } };
it('does not notify', () => {
  broadcast();
  expect(send).not.toHaveBeenCalled();
});
`
  );

  assert.equal(violations.length, 1);
});

// ## conservative direction

test('leaves an empty listing alone when the file asserts nothing about sends', async () => {
  const violations = await violationsFor(
    'boot-order.test.ts',
    `${EMPTY_LISTING_MOCK}
it('registers handlers in order', () => {
  expect(handlers.get('mcp:status:get')).toBeDefined();
});
`
  );

  assert.deepEqual(violations, []);
});

// mcp-elicitation-bridge.test.ts asserts on `window.webContents.send` and names
// getAllWindows only in a comment recording that the bridge deliberately does
// not enumerate it. Reading that comment as a stub would accuse a correct file.
test('a comment that merely names getAllWindows is not a stub', async () => {
  const violations = await violationsFor(
    'elicitation.test.ts',
    `// Consent payloads reach tracked visible-UI windows only; the bridge never
// enumerates BrowserWindow.getAllWindows(): vi.fn(() => []).
it('delivers consent to the tracked window', () => {
  expect(window.webContents.send).toHaveBeenCalledWith('mcp:elicitation:request', payload);
});
`
  );

  assert.deepEqual(violations, []);
});

test('a file with any non-empty listing anywhere is left alone', async () => {
  const violations = await violationsFor(
    'mixed.test.ts',
    `${EMPTY_LISTING_MOCK}
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
`
  );

  assert.deepEqual(violations, []);
});

test('a waived file is reported stale once it stops violating', async () => {
  const root = await writeFixture({
    [`${TEST_DIR}/main/reformed.test.ts`]: `vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send } }]),
  },
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

// Stated rather than hidden: the guard recognises a send recorder by the window
// shape it is installed into, or by the shared helper that builds one. A bare
// `const send = vi.fn()` that is asserted on but never given a `webContents`
// shape anywhere in the file is invisible to it. Catching that would mean
// guessing from an identifier's NAME, which trades this blind spot for false
// accusations against every unrelated `send` mock in the tree — a worse deal for
// a guard whose whole job is to stop unearned greens.
test('known blind spot: an orphaned send mock with no window shape is not detected', async () => {
  const violations = await violationsFor(
    'orphan.test.ts',
    `${EMPTY_LISTING_MOCK}
it('notifies', () => {
  const send = vi.fn();
  publish();
  expect(send).not.toHaveBeenCalled();
});
`
  );

  assert.deepEqual(violations, []);
});

// BST-1624. Not every apps/desktop send site routes through the window
// listing. src/terminal-ipc-handlers.ts sends to a WebContents held in its own
// live-terminal registry, and a test for it supplies that WebContents itself,
// so condition (1) of the rule — a window listing stub that resolves empty —
// is absent and the guard is silent.
//
// Whether a given site qualifies is a property of the CALL SITE, not the file:
// llm-host-manager.ts and chunking-host-manager.ts both reach
// getAllWindows() despite reading as point-to-point, so they are IN scope. The
// guard header carries the full criterion.
//
// That silence is correct, not a miss. The vacuous green this guard polices
// needs a listing a test can hollow out; there is no listing here to hollow.
// Widening the rule to "any send assertion" would flag every one of those
// files while removing no false green, which is the waiver-inflation failure
// mode the precision block above exists to prevent.
//
// The converse is a real cost and has a route: a registry-routed test that also
// happens to stub the listing empty for unrelated reasons IS flagged, because
// the guard fires on co-location rather than on causation. That is deliberate —
// tightening it would cost more precision than it buys — and the second half of
// this test locks the behaviour in. If you hit it, add a reasoned entry to
// EMPTY_WINDOW_SEND_ASSERTION_WAIVERS in the guard, next to the
// workspace-open-lifecycle one; stale entries fail the real-tree test above, so
// the waiver cannot outlive its reason.
//
// The cost of the limit is a REPORTING one, and it has already been paid once.
// BST-1622's audit no-opped every `.webContents.send(` site and ran the desktop
// suite; the two terminal sites showed no failure, so they were filed as
// untested (BST-1624). They are not. `apps/desktop`'s `test` script carries
// `--exclude "**/*.integration.test.*"`, and the terminal broadcast's coverage
// lives entirely in terminal-ipc-handlers.integration.test.ts, which that
// script cannot see. Re-run with both sites no-opped and the unit lane stays
// fully green while the integration lane fails on `owner.exitEvents` and
// `aggregatedData`.
//
// (Measured 2026-09-06 at 232620de2: 4388/4388 unit green, 4 integration
// failures. Quoted for provenance, not as a contract — those totals move with
// every added test or send site, so re-measure rather than trusting them.)
//
// The durable point survives any of those numbers moving: a survival observed
// in one lane is evidence about that lane only.
const REGISTRY_ROUTED_TEST = `const send = vi.fn();
// The owner WebContents is handed to the handler directly: a live-terminal
// registry entry, not a BrowserWindow listing.
const owner = { isDestroyed: () => false, webContents: { send } };

it('pushes terminal output to its owner', () => {
  writeToTerminal(owner, 'HELLO');
  expect(send).toHaveBeenCalledWith('terminal:data', { data: 'HELLO', terminalId: 't1' });
});
`;

const REGISTRY_ROUTED_FIXTURE_NAME = 'registry-routed.test.ts';

test('known blind spot: a registry-routed send with no window listing is outside the rule', async () => {
  // Both directions, so the silence is attributable. The recorder and the
  // assertion are the shapes the guard DOES recognise — `send` installed into
  // a `webContents` object, asserted via `expect(send)` — and both runs use the
  // same fixture NAME, so the listing stub is the only variable between them.
  // An earlier draft used a FakeWebContents CLASS and asserted on its recorded-
  // events array, which the guard does not recognise as a recorder at all: it
  // passed for the wrong reason and stayed green even with the listing added.
  assert.deepEqual(await violationsFor(REGISTRY_ROUTED_FIXTURE_NAME, REGISTRY_ROUTED_TEST), []);

  const withEmptyListing = await violationsFor(
    REGISTRY_ROUTED_FIXTURE_NAME,
    `${EMPTY_LISTING_MOCK}\n${REGISTRY_ROUTED_TEST}`
  );

  // Identify the violation rather than counting it: a bare length check would
  // stay green if EMPTY_LISTING_MOCK ever tripped some unrelated rule — the
  // same "passed for the wrong reason" trap the draft above fell into.
  assert.equal(withEmptyListing.length, 1);
  assert.equal(withEmptyListing[0].filePath, `${TEST_DIR}/main/${REGISTRY_ROUTED_FIXTURE_NAME}`);
  assert.match(withEmptyListing[0].reason, /every BrowserWindow\.getAllWindows\(\) stub/);
});

// ## unit-level shapes

test('classifyWindowListingStubs reads each stub form and refuses to guess', () => {
  const stubs = classifyWindowListingStubs(
    [
      'vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));',
      'vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([win]);',
      'const getAllWindowsMock = vi.fn(() => []);',
      '(BrowserWindow as any).getAllWindows = () => [];',
      // The alias form real files use: the value lives on another binding, so
      // the guard refuses to guess rather than calling it empty.
      'const surface = { getAllWindows: getAllWindowsMock };',
    ].join('\n')
  );

  assert.deepEqual(
    stubs.map((stub) => `${stub.lineNumber}:${stub.kind}`),
    ['1:empty', '2:non-empty', '3:empty', '4:empty', '5:unknown']
  );
});

test('collectSendRecorders separates window objects from send values', () => {
  const recorders = collectSendRecorders(
    `import { createRecordingWindow } from '../helpers/electron-main-test-harness';
const rendererWindow = createRecordingWindow();
const send = rendererWindow.send;
let sentEvents;
sentEvents = rendererWindow.events;
const plain = { isDestroyed: () => false, webContents: { send: recordSend } };
`
  );

  assert.deepEqual([...recorders.objects].sort(), ['plain', 'rendererWindow']);
  assert.deepEqual([...recorders.values].sort(), ['recordSend', 'send', 'sentEvents']);
});

test('findRendererSendAssertions reports the subject and line of each hit', () => {
  const assertions = findRendererSendAssertions(
    `const win = { isDestroyed: () => false, webContents: { send } };
it('x', () => {
  expect(win.isDestroyed()).toBe(false);
  expect(send).toHaveBeenCalledOnce();
});
`
  );

  assert.deepEqual(assertions, [{ lineNumber: 4, subject: 'send' }]);
});
