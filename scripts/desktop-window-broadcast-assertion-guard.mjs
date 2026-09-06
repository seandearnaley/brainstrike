// BST-1622: a desktop main-process test may not assert on what the renderer was
// told while stubbing the window listing empty.
//
// The main -> renderer broadcasts this guard is about iterate
// `BrowserWindow.getAllWindows()` (src/ipc-mcp.ts, src/mcp/lifecycle-control.ts,
// src/ipc-domains/db-ipc.ts, src/assistant-server/workspace-context-tools.ts and
// eight sites in src/main.ts). Every one is a `for (const window of ...)` loop.
// With `getAllWindows: () => []` the loop body never runs, so an assertion about
// what the renderer received — `expect(send).toHaveBeenCalledWith(...)` and,
// worse, its `.not.` twin — passes whether or not the production code sends
// anything. The test reports a green it never earned.
//
// SCOPE, stated because an earlier version of this comment over-claimed
// "every main -> renderer broadcast" (BST-1624). It is not every send site.
// Others — src/terminal-ipc-handlers.ts, the host managers, the browser pane
// host — send through a WebContents the caller already holds, with no listing
// involved. Those are outside the rule ON PURPOSE, not by oversight: the
// vacuous-green mechanism above needs a listing that a test can stub empty,
// and a test for a directly-held WebContents supplies that object itself, so
// there is nothing to hollow out. See the paired "known blind spot" test.
//
// WHY A REAL PARSE RATHER THAN A SCANNER (review of #2951). The first version of
// this guard matched tokens, read the ~90 characters after them, and hand-rolled
// its own comment/string tracking. Both choices produced bugs of exactly the
// kind this guard exists to prevent:
//   * `expect(...getAllWindows()).toEqual([])` — an ASSERTION — was read as an
//     empty STUB, and a real non-empty stub (`mockReturnValue(windows as never)`)
//     was read as empty because an unrelated `[]` sat 60 characters later. A
//     guard that fails a correct file trains people to add waivers, and a waiver
//     list that grows on noise is how a guard stops meaning anything.
//   * a quote inside a regex literal (`/['"]/`) desynchronised the scanner for
//     the REST OF THE FILE, so every later verdict was unreliable in either
//     direction, with no bail-out.
// Both classes disappear once the parser owns lexing and the questions become
// structural — "is this node a stub assignment?", "does this expect() subject
// reference a send?" — instead of "what characters follow this token?". This is
// the AST-guard pattern already established in scripts/ (see
// provider-registry-ast-helpers.mjs and assistant-run-id-producer-guard.mjs).
//
// Shape of the rule. A file is a violation when BOTH hold:
//   1. it contains at least one window-listing STUB and every one of them
//      resolves to an EMPTY array (a stub whose value is not statically
//      readable resolves to 'unknown' and exempts the file — the conservative
//      direction, since a false accusation costs more than a miss), and
//   2. it asserts on a renderer send — `expect(...webContents.send...)`, or
//      `expect(<recorder>)` where `<recorder>` names a window's send mock, the
//      array that mock records into, or a recording window's send-bearing
//      members.
//
// Exemptions are a named allowlist, not an inferred escape hatch: a test whose
// windows reach it through a mocked `BrowserWindow` CONSTRUCTOR observes sends
// without the listing, and inferring that from "the file mocks a constructor"
// would silently clear any future file that mocks one for unrelated reasons.
// Allowlist entries are checked both ways — an entry that stops violating fails
// too, so the waiver cannot outlive the reason for it.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_TEST_ROOT = path.join('apps', 'desktop', 'src', '__tests__');
const TEST_FILE_SUFFIXES = ['.ts', '.tsx', '.mts'];

// Anti-vacuous-green floor: if discovery silently walks nothing, every
// assertion downstream passes while checking zero files — the very failure
// mode this guard exists to police.
export const MIN_DESKTOP_TEST_FILES = 300;

/**
 * Files that legitimately pair an empty window listing with a send assertion.
 * Keyed by repo-relative POSIX path; the value is the reason, surfaced in the
 * failure message when an entry goes stale.
 */
export const EMPTY_WINDOW_SEND_ASSERTION_WAIVERS = new Map([
  [
    'apps/desktop/src/__tests__/main/workspace-open-lifecycle.test.ts',
    'OPEN_PATH_CHANNEL delivery is asserted on the windows the mocked BrowserWindow ' +
      'CONSTRUCTOR hands the test (mockWindowInstances), never on the getAllWindows() ' +
      'listing. The empty listing is load-bearing rather than lazy: it is what ' +
      "app.on('activate')'s hasVisibleWindow check reads when the test simulates the " +
      'user closing the last window.',
  ],
]);

export function parseTestSource(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Strip `as`/`satisfies`/parens/non-null wrappers down to the real expression. */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

// The listing property is `getAllWindows`; the mock VARIABLES tests bind it to
// are conventionally `getAllWindowsMock` and friends.
const LISTING_MOCK_NAME = /^getAllWindows/;

const MOCK_VALUE_SETTERS = new Set([
  'mockImplementation',
  'mockImplementationOnce',
  'mockReturnValue',
  'mockReturnValueOnce',
]);

function nameTextOf(node) {
  if (node && (ts.isIdentifier(node) || ts.isStringLiteral(node))) {
    return node.text;
  }
  return;
}

/** Does this expression denote the window-listing mock, so `.mockReturnValue` on it is a stub? */
function denotesListingMock(node) {
  let found = false;
  const visit = (current) => {
    if (found) {
      return;
    }
    if (ts.isIdentifier(current) && LISTING_MOCK_NAME.test(current.text)) {
      found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(current) && LISTING_MOCK_NAME.test(current.name.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isViFnCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'fn'
  );
}

/** The single `return <expr>` of a block body, ignoring nested functions. */
function singleReturnExpression(block) {
  const returns = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      returns.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return returns.length === 1 ? returns[0] : undefined;
}

/**
 * Resolves what a stub hands back: 'empty', 'non-empty', or 'unknown' when the
 * value is not a statically readable array literal (an identifier, a promise, a
 * helper call). 'unknown' exempts the file — deliberately, because guessing here
 * is what produced false accusations before.
 */
export function resolveListingValue(node, depth = 0) {
  const expr = unwrap(node);
  if (!expr || depth > 6) {
    return 'unknown';
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.length === 0 ? 'empty' : 'non-empty';
  }
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    if (!ts.isBlock(expr.body)) {
      return resolveListingValue(expr.body, depth + 1);
    }
    const returned = singleReturnExpression(expr.body);
    return returned ? resolveListingValue(returned, depth + 1) : 'unknown';
  }
  if (isViFnCall(expr)) {
    return expr.arguments.length > 0
      ? resolveListingValue(expr.arguments[0], depth + 1)
      : 'unknown';
  }
  return 'unknown';
}

/**
 * Every window-listing STUB in the file, structurally identified. An ordinary
 * reference — a call, an assertion on the mock — is not a stub and does not
 * appear here at all, so it can neither be mistaken for an empty listing nor
 * exempt the file by looking 'unknown'.
 *
 * @param {string} source
 * @param {string} [fileName]
 */
export function classifyWindowListingStubs(source, fileName = 'test.ts') {
  const sourceFile = parseTestSource(source, fileName);
  const stubs = [];
  const record = (node, valueNode) => {
    stubs.push({ kind: resolveListingValue(valueNode), lineNumber: lineOf(sourceFile, node) });
  };

  const visit = (node) => {
    // `{ getAllWindows: <value> }` — the vi.mock factory and Object.assign forms.
    if (ts.isPropertyAssignment(node) && LISTING_MOCK_NAME.test(nameTextOf(node.name) ?? '')) {
      record(node, node.initializer);
    }
    // `{ getAllWindows }` — the value lives elsewhere.
    else if (ts.isShorthandPropertyAssignment(node) && LISTING_MOCK_NAME.test(node.name.text)) {
      record(node, undefined);
    }
    // `(BrowserWindow as any).getAllWindows = <value>`
    else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      LISTING_MOCK_NAME.test(node.left.name.text)
    ) {
      record(node, node.right);
    }
    // `const getAllWindowsMock = vi.fn(() => [])`
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      LISTING_MOCK_NAME.test(node.name.text) &&
      node.initializer
    ) {
      record(node, node.initializer);
    }
    // `vi.mocked(BrowserWindow.getAllWindows).mockReturnValue(<value>)`
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MOCK_VALUE_SETTERS.has(node.expression.name.text) &&
      denotesListingMock(node.expression.expression)
    ) {
      record(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return stubs;
}

const RECORDING_WINDOW_FACTORY = 'createRecordingWindow';
// Members of a recording window that carry what the renderer was told. An
// assertion on any OTHER member (`isDestroyed()`, `id`) is not a send assertion:
// treating the whole window object as a recorder is what made the first draft
// reject valid tests.
const SEND_BEARING_MEMBERS = new Set(['events', 'payloadsFor', 'send', 'webContents']);

function webContentsSendProperties(objectLiteral) {
  const found = [];
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || nameTextOf(property.name) !== 'webContents') {
      continue;
    }
    const webContents = unwrap(property.initializer);
    if (!ts.isObjectLiteralExpression(webContents)) {
      continue;
    }
    for (const inner of webContents.properties) {
      if (nameTextOf(inner.name) === 'send') {
        found.push(inner);
      }
    }
  }
  return found;
}

/** The array a `send: (channel, payload) => { X.push(...) }` recorder records into. */
function pushSinkOf(fnNode) {
  const fn = unwrap(fnNode);
  if (!(fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))) {
    return;
  }
  let sink;
  const visit = (node) => {
    if (sink) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      ts.isIdentifier(node.expression.expression)
    ) {
      sink = node.expression.expression.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return sink;
}

/**
 * Names a file binds to a window's send machinery.
 *
 * `objects` are recording windows — an assertion counts only when it touches a
 * SEND-BEARING member of one. `values` are the send mock itself, or the array it
 * records into, which assertions name directly.
 */
export function collectSendRecorders(source, fileName = 'test.ts') {
  const sourceFile = parseTestSource(source, fileName);
  const objects = new Set();
  const values = new Set();

  const seed = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const sendProperty of webContentsSendProperties(node)) {
        if (ts.isShorthandPropertyAssignment(sendProperty)) {
          values.add(sendProperty.name.text);
          continue;
        }
        if (!ts.isPropertyAssignment(sendProperty)) {
          continue;
        }
        const value = unwrap(sendProperty.initializer);
        if (ts.isIdentifier(value)) {
          values.add(value.text);
          continue;
        }
        const sink = pushSinkOf(value);
        if (sink) {
          values.add(sink);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const isFactoryCall =
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === RECORDING_WINDOW_FACTORY;
      const isSendBearingLiteral =
        ts.isObjectLiteralExpression(initializer) &&
        webContentsSendProperties(initializer).length > 0;
      if (isFactoryCall || isSendBearingLiteral) {
        objects.add(node.name.text);
      }
    }
    ts.forEachChild(node, seed);
  };
  seed(sourceFile);

  // Close over renames (`const send = rendererWindow.send;`,
  // `sentEvents = rendererWindow.events;`) to a fixpoint, so a file that renames
  // the recorder once — or twice — is still seen.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = objects.size + values.size;
    const alias = (targetName, valueNode) => {
      const value = unwrap(valueNode);
      if (!(value && targetName)) {
        return;
      }
      if (ts.isIdentifier(value)) {
        if (objects.has(value.text)) {
          objects.add(targetName);
        } else if (values.has(value.text)) {
          values.add(targetName);
        }
        return;
      }
      if (
        ts.isPropertyAccessExpression(value) &&
        ts.isIdentifier(value.expression) &&
        objects.has(value.expression.text) &&
        SEND_BEARING_MEMBERS.has(value.name.text)
      ) {
        values.add(targetName);
      }
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        alias(node.name.text, node.initializer);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        alias(node.left.text, node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (objects.size + values.size === before) {
      break;
    }
  }

  return { objects, values };
}

function subjectAssertsRendererSend(subject, recorders) {
  let matched = false;
  const visit = (node) => {
    if (matched) {
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const target = unwrap(node.expression);
      // `<anything>.webContents.send`
      if (
        node.name.text === 'send' &&
        ts.isPropertyAccessExpression(target) &&
        target.name.text === 'webContents'
      ) {
        matched = true;
        return;
      }
      // `<recordingWindow>.send | .events | .payloadsFor | .webContents`
      if (
        ts.isIdentifier(target) &&
        recorders.objects.has(target.text) &&
        SEND_BEARING_MEMBERS.has(node.name.text)
      ) {
        matched = true;
        return;
      }
      // The property NAME is never a standalone recorder reference, so walk the
      // object side only — this is what keeps `expect(window.isDestroyed())`
      // from reading as a send assertion.
      visit(node.expression);
      return;
    }
    if (ts.isIdentifier(node) && recorders.values.has(node.text)) {
      matched = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(subject);
  return matched;
}

/** Assertions whose subject is a renderer send. */
export function findRendererSendAssertions(source, fileName = 'test.ts') {
  const sourceFile = parseTestSource(source, fileName);
  const recorders = collectSendRecorders(source, fileName);
  const assertions = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect' &&
      node.arguments.length > 0 &&
      subjectAssertsRendererSend(node.arguments[0], recorders)
    ) {
      assertions.push({
        lineNumber: lineOf(sourceFile, node),
        subject: node.arguments[0].getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return assertions;
}

async function collectTestFiles(absoluteRoot) {
  const found = [];
  let entries;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const absolute = path.join(absoluteRoot, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectTestFiles(absolute)));
      continue;
    }
    if (TEST_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * @param {{ root?: string, waivers?: Map<string, string> }} [options]
 * @returns {Promise<{ inspectedFileCount: number, staleWaivers: string[], violations: Array<{ filePath: string, lineNumber: number, reason: string }> }>}
 */
export async function findVacuousWindowBroadcastAssertions(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const waivers = options.waivers ?? EMPTY_WINDOW_SEND_ASSERTION_WAIVERS;
  const files = await collectTestFiles(path.join(root, DESKTOP_TEST_ROOT));
  const violations = [];
  const waivedAndStillViolating = new Set();

  for (const absolute of files.sort()) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const source = await readFile(absolute, 'utf8');
    const stubs = classifyWindowListingStubs(source, relative);
    const emptyOnly = stubs.length > 0 && stubs.every((stub) => stub.kind === 'empty');
    if (!emptyOnly) {
      continue;
    }
    const assertions = findRendererSendAssertions(source, relative);
    if (assertions.length === 0) {
      continue;
    }
    if (waivers.has(relative)) {
      waivedAndStillViolating.add(relative);
      continue;
    }
    const first = assertions[0];
    violations.push({
      filePath: relative,
      lineNumber: first.lineNumber,
      reason:
        `asserts on a renderer send (\`expect(${first.subject})\`) while every ` +
        'BrowserWindow.getAllWindows() stub in the file returns [] (line ' +
        `${stubs[0].lineNumber}). Main broadcasts by iterating that listing, so with ` +
        'no windows the loop body never runs and the assertion — the `.not.` form ' +
        'especially — holds whether or not production sends anything. Give the ' +
        'listing a recording window (createRecordingWindow in ' +
        'apps/desktop/src/__tests__/helpers/electron-main-test-harness.ts), or add a ' +
        'reasoned waiver to EMPTY_WINDOW_SEND_ASSERTION_WAIVERS if the sends genuinely ' +
        'reach the test by another route.' +
        (assertions.length > 1 ? ` ${assertions.length - 1} more in this file.` : ''),
    });
  }

  const staleWaivers = [...waivers.keys()].filter(
    (relative) => !waivedAndStillViolating.has(relative)
  );
  return { inspectedFileCount: files.length, staleWaivers, violations };
}

async function main() {
  const { inspectedFileCount, staleWaivers, violations } =
    await findVacuousWindowBroadcastAssertions();

  if (inspectedFileCount < MIN_DESKTOP_TEST_FILES) {
    console.error(
      `Inspected only ${inspectedFileCount} desktop test file(s), below the floor of ` +
        `${MIN_DESKTOP_TEST_FILES}. Discovery is broken, so a clean verdict here would be ` +
        'vacuous.'
    );
    process.exitCode = 1;
    return;
  }

  for (const relative of staleWaivers) {
    console.error(
      `- ${relative} — stale waiver in EMPTY_WINDOW_SEND_ASSERTION_WAIVERS: the file no ` +
        'longer pairs an empty window listing with a send assertion. Remove the entry. ' +
        `Recorded reason: ${EMPTY_WINDOW_SEND_ASSERTION_WAIVERS.get(relative)}`
    );
  }
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.lineNumber} — ${violation.reason}`);
  }

  if (staleWaivers.length > 0 || violations.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `No vacuous renderer-broadcast assertions across ${inspectedFileCount} desktop test files.`
  );
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
