#!/usr/bin/env node
/**
 * Live CDT verification for W4's forge UI (BST-1391).
 *
 * Attaches to a RUNNING desktop app started with
 * `pnpm --filter @brainstrike/desktop dev:agent-debug` (CDP on 127.0.0.1:9222
 * by default — see `apps/desktop/agent-devtools-defaults.json`, overridable
 * via `BRAINSTRIKE_AGENT_DEVTOOLS_PORT`) and prints COMPUTED VALUES —
 * presence, text, attributes, geometry — never an impression. A verification
 * report that says "looks right" is not evidence.
 *
 * NOT named `verify-*.mjs`: `scripts/__tests__/verify-script-entrypoints.test.mjs`
 * (BST-836) requires every `verify-*` script to be a STATIC repo-tree guard —
 * export `main({ directory, repoRoot })`, refuse to report success against an
 * empty/bogus root, and exit non-zero on a real drift. This script is a
 * different kind of tool: it connects to a LIVE, already-running Electron
 * renderer over CDP and has no `directory`/`repoRoot` concept to check, so
 * forcing that signature on it would be a fake fit, not a real one. `probe-`
 * names the live-runtime-inspector category instead.
 *
 * Usage: node scripts/probe-forge-ui.mjs [cdpUrl]
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

async function main(cdpUrl) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
    // Hidden inference/worker hosts (chunking-host, embedding-host, …) carry a
    // `mode=` query param on the SAME origin as the UI renderer, so filtering on
    // `devtools://` alone is not enough to exclude them.
    const page = pages.find(
      (candidate) =>
        !(candidate.url().startsWith('devtools://') || candidate.url().includes('mode='))
    );
    if (!page) {
      throw new Error(`No renderer page found over CDP at ${cdpUrl}.`);
    }

    const report = await page.evaluate(() => {
      const read = (element) =>
        element === null
          ? null
          : {
              checks: element.getAttribute('data-checks'),
              height: Math.round(element.getBoundingClientRect().height),
              label: element.getAttribute('aria-label'),
              stale: element.getAttribute('data-stale'),
              tag: element.tagName,
              text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim(),
            };
      const bar = document.querySelector('[data-testid="workspace-bar"]');
      const branch = document.querySelector('[data-testid="workspace-bar-branch-chip"]');
      const prChip = document.querySelector('[data-testid="workspace-bar-pr-chip"]');
      const diagnostic = document.querySelector(
        '[data-testid="workspace-bar-branch-forge-diagnostic"]'
      );
      const pills = [...document.querySelectorAll('[data-testid="thread-pr-pill"]')].map(
        (pill) => ({
          checks: pill.getAttribute('data-checks'),
          state: pill.getAttribute('data-state'),
          text: (pill.textContent ?? '').replace(/\s+/gu, ' ').trim(),
        })
      );
      return {
        barChildCount: bar ? bar.children.length : 0,
        barPresent: bar !== null,
        branchChip: read(branch),
        branchDiagnosticPresent: diagnostic !== null,
        branchDiagnosticText: diagnostic ? (diagnostic.textContent ?? '').trim() : null,
        prChip: read(prChip),
        // A chip that is present but zero-height is not visible; report the number.
        prChipHeight: prChip ? Math.round(prChip.getBoundingClientRect().height) : null,
        prChipPresent: prChip !== null,
        threadPrPills: pills,
      };
    });

    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cdpUrl =
    process.argv[2] ?? `http://127.0.0.1:${process.env.BRAINSTRIKE_AGENT_DEVTOOLS_PORT ?? '9222'}`;
  await main(cdpUrl);
}

export { main };
