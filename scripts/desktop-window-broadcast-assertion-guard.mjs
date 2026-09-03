// BST-1622: a desktop main-process test may not assert on what the renderer was
// told while stubbing the window listing empty.
//
// Every main -> renderer broadcast in apps/desktop iterates
// `BrowserWindow.getAllWindows()` (src/ipc-mcp.ts, src/mcp/lifecycle-control.ts,
// src/ipc-domains/db-ipc.ts, src/assistant-server/workspace-context-tools.ts and
// eight sites in src/main.ts). Every one is a `for (const window of ...)` loop.
// With `getAllWindows: () => []` the loop body never runs, so an assertion about
// what the renderer received — `expect(send).toHaveBeenCalledWith(...)` and,
// worse, its `.not.` twin — passes whether or not the production code sends
// anything. The test reports a green it never earned.
//
// This guard is STATIC on purpose: the property is decidable from the source of
// a single test file, so it costs nothing at runtime and cannot itself go
// vacuous the way the assertions it protects did.
//
// Shape of the rule. A file is a violation when BOTH hold:
//   1. every `getAllWindows` stub in it yields an EMPTY array (a file with no
//      stub at all, or with any stub whose contents this guard cannot read, is
//      left alone — the conservative direction, since a false accusation here
//      costs more than a miss), and
//   2. it asserts on a renderer send — either `expect(...webContents.send...)`
//      directly, or `expect(<recorder>)` where `<recorder>` is an identifier the
//      file installs as a window's `webContents.send` (or the array such a
//      recorder pushes into).
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

/**
 * Removes line and block comments so a file that only MENTIONS getAllWindows in
 * prose (mcp-elicitation-bridge.test.ts does exactly that, to record that the
 * bridge deliberately does not enumerate it) is not read as stubbing it.
 * String and template literals are tracked so a `//` inside a URL survives.
 */
export function stripCommentsAndStrings(source) {
  let out = '';
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === '\\') {
        out += '  ';
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      out += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; index < stop; index += 1) {
        out += source[index] === '\n' ? '\n' : ' ';
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * Reads the argument text of the `expect(` starting at `openParenIndex` by
 * balancing parentheses, so a multi-line subject is classified from the whole
 * subject rather than from whichever fragment happens to share a line.
 */
function readBalanced(source, openParenIndex) {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenIndex + 1, index);
      }
    }
  }
  return source.slice(openParenIndex + 1);
}

const WINDOW_LISTING_PATTERN = /\bgetAllWindows\w*\b/g;
// How far past a `getAllWindows` occurrence to look for the array literal it is
// given. Wide enough for `vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([`
// and its `mockImplementation(() => [` twin, narrow enough not to swallow an
// unrelated array on a following statement.
const LISTING_VALUE_LOOKAHEAD = 90;

/**
 * Classifies each `getAllWindows` occurrence as 'empty', 'non-empty' or
 * 'unknown' (an alias binding, or an assertion ON the mock, where the guard
 * cannot see the value).
 */
export function classifyWindowListingStubs(code) {
  const stubs = [];
  WINDOW_LISTING_PATTERN.lastIndex = 0;
  let match = WINDOW_LISTING_PATTERN.exec(code);
  while (match !== null) {
    const window = code.slice(match.index, match.index + LISTING_VALUE_LOOKAHEAD);
    const bracket = window.indexOf('[');
    let kind = 'unknown';
    if (bracket !== -1) {
      kind = /^\[\s*\]/.test(window.slice(bracket)) ? 'empty' : 'non-empty';
    }
    stubs.push({ kind, lineNumber: lineNumberAt(code, match.index) });
    match = WINDOW_LISTING_PATTERN.exec(code);
  }
  return stubs;
}

// `webContents: { send: recordSend }`
const NAMED_RECORDER_PATTERN = /webContents\s*:\s*\{\s*send\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g;
// `send: (channel, payload) => { sentEvents.push(...) }` — assertions then read
// the ARRAY, never the function, so the array name counts as a recorder too.
const RECORDER_SINK_PATTERN =
  /send\s*:\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,240}?([A-Za-z_$][\w$]*)\.push\(/g;
// The shared helper this guard points violators at. A file that adopts it must
// stay just as visible here as the hand-rolled literal it replaced — otherwise
// the fix for one vacuous assertion would blind the guard to the next.
const HELPER_WINDOW_PATTERN =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRecordingWindow\s*\(/g;
// `const send = rendererWindow.send;` / `sentEvents = rendererWindow.events;`
const RECORDER_ALIAS_PATTERN =
  /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)(?:\.[\w$]+)*\s*;/g;

/** Identifiers a file installs as (or reads back from) a window's `webContents.send`. */
export function collectSendRecorderNames(code) {
  const names = new Set();
  if (/webContents\s*:\s*\{\s*send\s*[,}]/.test(code)) {
    names.add('send');
  }
  for (const pattern of [NAMED_RECORDER_PATTERN, RECORDER_SINK_PATTERN, HELPER_WINDOW_PATTERN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(code);
    while (match !== null) {
      names.add(match[1]);
      match = pattern.exec(code);
    }
  }
  // Close over aliases (`const send = rendererWindow.send;`) to a fixpoint, so a
  // file that renames the recorder once — or twice — is still seen.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = names.size;
    RECORDER_ALIAS_PATTERN.lastIndex = 0;
    let alias = RECORDER_ALIAS_PATTERN.exec(code);
    while (alias !== null) {
      if (names.has(alias[2])) {
        names.add(alias[1]);
      }
      alias = RECORDER_ALIAS_PATTERN.exec(code);
    }
    if (names.size === before) {
      break;
    }
  }
  return names;
}

/** Assertions whose subject is a renderer send. */
export function findRendererSendAssertions(code) {
  const recorderNames = collectSendRecorderNames(code);
  const assertions = [];
  const expectPattern = /\bexpect\s*\(/g;
  let match = expectPattern.exec(code);
  while (match !== null) {
    const openParen = code.indexOf('(', match.index);
    const subject = readBalanced(code, openParen);
    const direct = subject.includes('webContents') && /\bsend\b/.test(subject);
    const viaRecorder = [...recorderNames].some((name) =>
      new RegExp(`(^|[^\\w$.])${name}(\\b|$)`).test(subject)
    );
    if (direct || viaRecorder) {
      assertions.push({
        lineNumber: lineNumberAt(code, match.index),
        subject: subject.trim().replace(/\s+/g, ' ').slice(0, 120),
      });
    }
    match = expectPattern.exec(code);
  }
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
    const code = stripCommentsAndStrings(await readFile(absolute, 'utf8'));
    const stubs = classifyWindowListingStubs(code);
    if (stubs.length === 0) {
      continue;
    }
    const emptyOnly =
      stubs.some((stub) => stub.kind === 'empty') && stubs.every((stub) => stub.kind === 'empty');
    if (!emptyOnly) {
      continue;
    }
    const assertions = findRendererSendAssertions(code);
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
