#!/usr/bin/env node
/**
 * Live CDT verification for BST-1390 W3 (project rule: a subagent reports
 * COMPUTED VALUES, not impressions).
 *
 * Attaches to the running dev app (`pnpm --filter @brainstrike/desktop
 * dev:agent-debug`, which opens CDP on 127.0.0.1:9222), drives the composer's
 * Branch/Mode chips and the two worktree dialogs, and prints one JSON report
 * with the values each probe read. Any failed assertion exits non-zero, so
 * this is usable as a gate and not just as a report.
 *
 * It never starts, stops, or reloads the app on its own, and never seeds a
 * workspace root — the project rule is that the dev server (and whatever
 * folder it has open) is already running. Point it at a real repository
 * first; `picker.count` is only meaningful against a real worktree topology.
 *
 * Page selection: the dev app also boots hidden, DOM-less renderer hosts for
 * local embedding/chunking inference (see docs/agents/local-inference.md), so
 * `context.pages()` can return several non-devtools targets at once. Picking
 * the first one is not reliable — verified live, it can land on a hidden host
 * page with an empty `document.body` and hang forever waiting for the bar.
 * `findMainPage` instead polls every non-devtools page for the composer
 * workspace bar and returns the first one that actually renders it.
 */
import { chromium } from 'playwright';

const ENDPOINT = process.env.BRAINSTRIKE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const requested = process.argv.includes('--probe')
  ? process.argv[process.argv.indexOf('--probe') + 1]
  : null;
const MAIN_PAGE_TIMEOUT_MS = 30_000;
const MAIN_PAGE_POLL_MS = 500;

const results = [];
let failures = 0;

function record(name, values, assertion) {
  const ok = assertion(values);
  if (!ok) {
    failures += 1;
  }
  results.push({ name, ok, values });
}

async function read(page, selector) {
  return await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      ariaLabel: element.getAttribute('aria-label'),
      disabled:
        element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      height: Math.round(rect.height),
      text: (element.textContent ?? '').trim(),
      title: element.getAttribute('title'),
      width: Math.round(rect.width),
      zIndex: style.zIndex,
    };
  }, selector);
}

/** Which element (tag + data-testid, when it has one) currently holds focus. */
async function readActiveElement(page) {
  return await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    testId: document.activeElement?.getAttribute('data-testid') ?? null,
  }));
}

/**
 * Reads the computed `color` a `text-amber-600 dark:text-amber-400` element
 * (the failed-setup `!` and the diagnostic-chip `!` both use exactly this
 * class pair) resolves to in light vs. dark mode, on the LIVE page's own
 * compiled stylesheet — not a guessed hex value.
 *
 * Forcing an actual "setup failed" worktree into the live app just to read
 * its color would mean creating a real git worktree with a deliberately
 * failing setup command and cleaning it up afterward — invasive or the kind
 * of thing that is likely to leave stray state behind for a color check.
 * Injecting a detached element with the same two classes reads the identical
 * CSS rule instead: no app state changes, and the element (and the page's
 * theme class) is restored before the probe returns.
 */
async function readAmberIndicatorColors(page) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    const hadLight = root.classList.contains('light');
    const span = document.createElement('span');
    span.className = 'text-amber-600 dark:text-amber-400';
    span.style.position = 'absolute';
    span.style.left = '-9999px';
    span.textContent = '!';
    document.body.appendChild(span);

    root.classList.remove('light', 'dark');
    root.classList.add('dark');
    const darkColor = getComputedStyle(span).color;

    root.classList.remove('dark');
    root.classList.add('light');
    const lightColor = getComputedStyle(span).color;

    document.body.removeChild(span);
    root.classList.remove('light', 'dark');
    if (hadDark) {
      root.classList.add('dark');
    }
    if (hadLight) {
      root.classList.add('light');
    }

    return { darkColor, lightColor };
  });
}

const probes = {
  async 'branch-chip'(page) {
    const chip = await read(page, '[data-testid="workspace-bar-branch-chip"]');
    record('branch-chip.geometry', chip, (v) => v !== null && v.height === 24 && v.width > 0);
    record('branch-chip.label', chip, (v) => (v?.ariaLabel ?? '').startsWith('Branch: On branch '));
    await page.click('[data-testid="workspace-bar-branch-chip"]');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="workspace-bar-branch-row-"]')].map((row) => ({
        disabled: row.getAttribute('data-disabled') !== null,
        reason:
          row.parentElement?.querySelector('[data-testid^="workspace-bar-branch-reason-"]')
            ?.textContent ?? null,
        testId: row.getAttribute('data-testid'),
      }))
    );
    record('branch-chip.rows', { rows }, (v) => v.rows.length > 0);
    record('branch-chip.reasons', { rows }, (v) =>
      v.rows.every((row) => !row.disabled || (row.reason ?? '').length > 0)
    );
    const menu = await read(page, '[role="menu"]');
    record('branch-chip.layer', menu, (v) => v?.zIndex === '70');
    await page.keyboard.press('Escape');
  },
  async 'create-sheet'(page) {
    await page.click('[data-testid="workspace-bar-mode-chip"]');
    await page.click('[data-testid="workspace-bar-mode-new-worktree"]');
    await page.waitForSelector('[data-testid="worktree-create-dialog"]', { timeout: 10_000 });
    const dialog = await read(page, '[data-testid="worktree-create-dialog"]');
    record('create-sheet.geometry', dialog, (v) => v !== null && v.width > 0);
    record('create-sheet.layer', dialog, (v) => v?.zIndex === '51');
    // The Mode chip's DropdownMenuItem closes the menu on select (Radix
    // default — no preventDefault is called), so by the time the sheet is
    // open the popup should already be gone. Assert that directly, and prove
    // the dialog would still out-rank it (POPUP_LAYER_CLASS z-[70] vs. this
    // tier's z-[51]) if it somehow weren't — see packages/ui/src/layers.ts.
    const menuDuringSheet = await read(page, '[role="menu"]');
    record(
      'create-sheet.stacking-above-menu',
      { dialogZIndex: dialog?.zIndex ?? null, menuPresent: menuDuringSheet !== null },
      (v) => !v.menuPresent
    );
    const branch = await page.inputValue('[data-testid="worktree-create-branch"]');
    const name = await page.inputValue('[data-testid="worktree-create-name"]');
    const location = await page.textContent('[data-testid="worktree-create-location"]');
    record(
      'create-sheet.defaults',
      { branch, location, name },
      (v) => v.branch.startsWith('bs/') && v.name.length > 0 && (v.location ?? '').length > 0
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="worktree-create-dialog"]', {
      state: 'detached',
      timeout: 10_000,
    });
    const active = await readActiveElement(page);
    record(
      'create-sheet.focus-returns-to-chip',
      active,
      (v) => v.testId === 'workspace-bar-mode-chip'
    );
  },
  async 'dark-mode-indicator'(page) {
    const colors = await readAmberIndicatorColors(page);
    record(
      'dark-mode-indicator.amber-color',
      colors,
      (v) =>
        typeof v.lightColor === 'string' &&
        v.lightColor.length > 0 &&
        typeof v.darkColor === 'string' &&
        v.darkColor.length > 0 &&
        v.darkColor !== v.lightColor
    );
  },
  async 'mode-chip'(page) {
    const chip = await read(page, '[data-testid="workspace-bar-mode-chip"]');
    record('mode-chip.geometry', chip, (v) => v !== null && v.height === 24 && v.width > 0);
    record('mode-chip.label', chip, (v) => v?.text === 'Local' || (v?.text ?? '').startsWith('⧉'));
    record('mode-chip.tooltip', chip, (v) => (v?.title ?? '').length > 0);
  },
  async picker(page) {
    await page.click('[data-testid="workspace-bar-mode-chip"]');
    await page.click('[data-testid="workspace-bar-mode-pick-worktree"]');
    await page.waitForSelector('[data-testid="worktree-picker-dialog"]');
    const dialog = await read(page, '[data-testid="worktree-picker-dialog"]');
    record('picker.layer', dialog, (v) => v?.zIndex === '51');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="worktree-picker-row-"]')].map((row) => {
        const name = (row.getAttribute('data-testid') ?? '').replace('worktree-picker-row-', '');
        const select = row.querySelector(`[data-testid="worktree-picker-select-${name}"]`);
        return {
          disabled: select?.hasAttribute('disabled') ?? true,
          grant: row.querySelector(`[data-testid="worktree-picker-grant-${name}"]`) !== null,
          name,
          reason:
            row.querySelector(`[data-testid="worktree-picker-reason-${name}"]`)?.textContent ??
            null,
          tool:
            row.querySelector(`[data-testid="worktree-picker-tool-${name}"]`)?.textContent ?? null,
        };
      })
    );
    record('picker.count', { count: rows.length }, (v) => v.count > 0);
    // The measured baseline on the real brainstrike repo was 25+ worktrees,
    // most of them outside every mounted root — so this must NOT be a short
    // list. `git worktree list` on this machine independently confirms the
    // same order of magnitude.
    record('picker.every-disabled-row-states-why', { rows }, (v) =>
      v.rows.every((row) => !row.disabled || (row.reason ?? '').length > 0)
    );
    record('picker.external-tools-labelled', { rows }, (v) =>
      v.rows
        .filter((row) => row.tool !== null)
        .every((row) => (row.reason ?? '') !== '' || !row.disabled)
    );
    record('picker.grant-offered-where-remediable', { rows }, (v) =>
      v.rows.filter((row) => (row.reason ?? '').includes('grant access')).every((row) => row.grant)
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="worktree-picker-dialog"]', {
      state: 'detached',
      timeout: 10_000,
    });
    const active = await readActiveElement(page);
    record('picker.focus-returns-to-chip', active, (v) => v.testId === 'workspace-bar-mode-chip');
  },
};

async function findMainPage(context) {
  const deadline = Date.now() + MAIN_PAGE_TIMEOUT_MS;
  for (;;) {
    const candidates = context
      .pages()
      .filter((candidate) => !candidate.url().startsWith('devtools://'));
    for (const candidate of candidates) {
      const hasBar = await candidate
        .evaluate(() => document.querySelector('[data-testid="workspace-bar"]') !== null)
        .catch(() => false);
      if (hasBar) {
        return candidate;
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, MAIN_PAGE_POLL_MS));
  }
}

const browser = await chromium.connectOverCDP(ENDPOINT);
const context = browser.contexts()[0];
const page = await findMainPage(context);
if (!page) {
  process.stderr.write(
    'No renderer page rendering the workspace bar was found on the CDP endpoint. ' +
      'Point the dev app at a real folder first.\n'
  );
  await browser.close();
  process.exit(2);
}

for (const [name, probe] of Object.entries(probes)) {
  if (requested && requested !== name) {
    continue;
  }
  await probe(page);
}

process.stdout.write(`${JSON.stringify({ failures, results }, null, 2)}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
