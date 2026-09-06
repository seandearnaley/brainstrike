#!/usr/bin/env node
/**
 * Live CDT verification for BST-1392 W5 (project rule: a subagent reports
 * COMPUTED VALUES, not impressions).
 *
 * Attaches to the running dev app (`pnpm --filter @brainstrike/desktop
 * dev:agent-debug`, which opens CDP on 127.0.0.1:9222) and drives the
 * Worktree Map tab: `scripts/cdt-verify-worktree-mode.mjs` (BST-1390 W3) is
 * the exact precedent for the connection/page-selection mechanics, reused
 * verbatim here.
 *
 * It never starts, stops, or reloads the app on its own except through the
 * SAME `electronAPI.storage` + `page.reload()` seam the desktop e2e suite's
 * `seed-root.ts` uses to seed a workspace root without a native file picker
 * — the caller is expected to have already run the app once via
 * `dev:agent-debug` so a real Electron renderer with `window.electronAPI`
 * exists to attach to. Point `--repo <path>` at a real on-disk git
 * repository first, with this exact topology on disk (a primary checkout
 * plus two sibling worktrees):
 *
 *   git init repo && git -C repo commit --allow-empty -m init
 *   git -C repo worktree add -b bs/wt-locked ../wt-locked
 *   git -C repo worktree add -b bs/pr-external ../pr-external
 *   git -C repo worktree lock ../wt-locked --reason "<any reason>"
 *
 * `pr-pill`/`indexing-toggle`/`gh-absent` all target the worktree named
 * literally `pr-external` by directory basename.
 *
 * `--probe <name>` runs one probe; omit it to run every probe in the
 * script's explicit `RUN_ORDER` (NOT the literal's alphabetical order —
 * Biome sorts the keys). `--repo <path>` is required for every probe except
 * `empty-state` and `add-menu`, which must run BEFORE any root is seeded
 * (that is the whole point of the empty-state check) and therefore never
 * take it. `RUN_ORDER` runs those two first; every seeding probe
 * (`card-colors` included — it seeds the fixture root itself) comes after.
 * An unknown `--probe` name, or an explicit `--probe` selection that needs
 * `--repo` without one, exits 2 up front — a run that executed no
 * verification must never report success. In a no-`--probe` run without
 * `--repo`, repo-dependent probes are skipped and listed in the JSON
 * output's `skipped` array.
 *
 * `gh-absent` needs a SEPARATE `dev:agent-debug` process launched with `gh`
 * genuinely unresolvable on PATH — Electron's own env is fixed at spawn, so
 * deleting a shimmed `gh` mid-session cannot simulate this; run every OTHER
 * probe against one session (optionally with a real or shimmed `gh` ahead of
 * PATH so `pr-pill` has something to fetch), then `gh-absent` alone against a
 * second session launched with no `gh` anywhere on PATH.
 */
import { chromium } from 'playwright';

const ENDPOINT = process.env.BRAINSTRIKE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const argv = process.argv.slice(2);
const requested = argv.includes('--probe') ? argv[argv.indexOf('--probe') + 1] : null;
const repoPath = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : null;
const MAIN_PAGE_TIMEOUT_MS = 30_000;
const MAIN_PAGE_POLL_MS = 500;
const SEED_ROOT_ID = 'w5-cdt-worktree-map-root-00000000-0000-4000-8000-000000000014';

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
    return {
      ariaLabel: element.getAttribute('aria-label'),
      disabled:
        element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      height: Math.round(rect.height),
      text: (element.textContent ?? '').trim(),
      title: element.getAttribute('title'),
      width: Math.round(rect.width),
    };
  }, selector);
}

/** Every `[data-testid="worktree-map-card"]`, as the fields Step 1 asks for. */
async function readCards(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="worktree-map-card"]')].map((card) => {
      const rect = card.getBoundingClientRect();
      const newThread = card.querySelector('[data-testid="worktree-map-new-thread"]');
      const badge = card.querySelector('[data-testid="worktree-map-indexing"]');
      const prButton = [...card.querySelectorAll('button')].find((button) =>
        /^#\d+/u.test((button.textContent ?? '').trim())
      );
      const disabledReasonEl = card.querySelector('[data-testid="worktree-map-disabled-reason"]');
      return {
        branchLabel: card.querySelector('[data-testid="worktree-map-branch"]')?.textContent ?? null,
        disabledReasonText: disabledReasonEl?.textContent ?? null,
        glyphAriaLabels: [...card.querySelectorAll('[role="img"]')].map((glyph) =>
          glyph.getAttribute('aria-label')
        ),
        indexingBadgeText: badge?.getAttribute('aria-label') ?? null,
        name: card.querySelector('h3')?.textContent ?? null,
        newThreadDisabled: newThread?.hasAttribute('disabled') ?? null,
        newThreadTitle: newThread?.getAttribute('title') ?? null,
        provenanceLabel:
          card.querySelector('[data-testid="worktree-map-provenance"]')?.textContent ?? null,
        prPillText: prButton?.textContent?.trim() ?? null,
        rect: { height: Math.round(rect.height), width: Math.round(rect.width) },
      };
    })
  );
}

/** The lane's own scroll metrics, per repository section, plus the page body's. */
async function readLaneMetrics(page) {
  return await page.evaluate(() => {
    const lanes = [...document.querySelectorAll('[data-testid="worktree-map-rows"]')].map(
      (lane) => ({
        clientWidth: lane.clientWidth,
        scrollWidth: lane.scrollWidth,
      })
    );
    return {
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      lanes,
    };
  });
}

/**
 * Reads the computed `background-color` and `color` of one worktree-map-card
 * on the LIVE page's own compiled stylesheet, toggling the root `light`/`dark`
 * class — the same technique `cdt-verify-worktree-mode.mjs`'s
 * `readAmberIndicatorColors` uses, applied to the card surface instead of the
 * amber indicator. No app state changes; the page's theme class is restored
 * before the probe returns.
 */
async function readCardColorsInBothThemes(page) {
  return await page.evaluate(() => {
    const card = document.querySelector('[data-testid="worktree-map-card"]');
    if (!card) {
      return null;
    }
    // Measure destination colors, not the first frame of the row's hover transition.
    const previousTransition = card.style.transition;
    card.style.transition = 'none';
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    const hadLight = root.classList.contains('light');

    root.classList.remove('light', 'dark');
    root.classList.add('dark');
    const darkStyle = getComputedStyle(card);
    const dark = { backgroundColor: darkStyle.backgroundColor, color: darkStyle.color };

    root.classList.remove('dark');
    root.classList.add('light');
    const lightStyle = getComputedStyle(card);
    const light = { backgroundColor: lightStyle.backgroundColor, color: lightStyle.color };

    root.classList.remove('light', 'dark');
    if (hadDark) {
      root.classList.add('dark');
    }
    if (hadLight) {
      root.classList.add('light');
    }
    card.style.transition = previousTransition;
    return { dark, light };
  });
}

/** Seed a workspace root by path via the same seam desktop e2e's `seed-root.ts`
 * uses (`electronAPI.storage.setItem` + reload), so no native file picker is
 * needed. Idempotent: safe to call again with a different path.
 *
 * Also points `worktreeSettings.managedDirectory` at the parent of `path` — a
 * REAL, production config knob (Settings can set the same key; it is not
 * test-mode-gated, see `worktree-settings.ts`'s `writeWorktreeSettings`), NOT
 * a workaround. Adoption refuses a worktree path outside every open root AND
 * outside the managed directory (`assertReachable` in `worktree-adopt.ts`);
 * this repo's sibling worktrees live next to `path`, not inside it, so
 * without this they are unreachable and Adopt fails loud with exactly that
 * message (found live, diagnosed, not the app being broken — this is the same
 * "outside every open folder" refusal BST-1392 W5's own e2e hit and fixed the
 * same way in worktree-map.desktop.test.ts's `freshRepoWithManagedExternalWorktree`). */
async function seedRootByPath(page, path) {
  await page.evaluate(
    async ({ id, p }) => {
      const storage = globalThis.electronAPI?.storage;
      if (!storage?.setItem) {
        throw new Error(
          'electronAPI.storage.setItem unavailable — is this really the Electron renderer?'
        );
      }
      await storage.setItem('lastFolderPath', p);
      await storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1_800_000_000_000, path: p, rootId: id }])
      );
      const parent = p.split('/').slice(0, -1).join('/');
      await storage.setItem(
        'worktreeSettings',
        JSON.stringify({ managedDirectory: parent, setupCommand: null })
      );
    },
    { id: SEED_ROOT_ID, p: path }
  );
  await page.reload();
  await page.waitForSelector('[data-testid="workspace-bar"]', { timeout: 30_000 });
}

async function openWorktreeMapTab(page) {
  await page.click('[data-testid="workspace-add-tab"]');
  await page.getByRole('menuitem', { name: /Worktrees/u }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="worktree-map-card"]') !== null ||
      document.body.textContent?.includes('No worktrees yet') === true,
    { timeout: 15_000 }
  );
}

const probes = {
  /** Task 7 Step 7, check 1 — routed to this pass by coordinator ruling. */
  async 'add-menu'(page) {
    await page.click('[data-testid="workspace-add-tab"]');
    const item = page.getByRole('menuitem', { name: /Worktrees/u });
    const present = await item.count();
    record('add-menu.item-present', { present }, (v) => v.present === 1);
    const iconClass = await item
      .locator('svg')
      .first()
      .getAttribute('class')
      .catch(() => null);
    record('add-menu.tree-icon', { iconClass }, (v) =>
      (v.iconClass ?? '').includes('lucide-trees')
    );
    await page.keyboard.press('Escape');
  },

  /** Brief Step 1, computed card colors in light vs. dark — tokens, not hex.
   * Seeds the fixture root itself: reading card colors needs cards, and in a
   * full run nothing ordered before this probe has seeded one. */
  async 'card-colors'(page) {
    await seedRootByPath(page, repoPath);
    await openWorktreeMapTab(page);
    const colors = await readCardColorsInBothThemes(page);
    record(
      'card-colors.tokenized-not-hardcoded',
      colors,
      (v) =>
        v !== null &&
        v.dark.backgroundColor !== v.light.backgroundColor &&
        v.dark.color !== v.light.color
    );
  },

  /** Brief Step 2, check 1 — RUN_ORDER runs this before any seeding probe. */
  async 'empty-state'(page) {
    await openWorktreeMapTab(page);
    const text = await page.evaluate(
      () => document.querySelector('[data-testid="workspace-tab-panel"], main')?.textContent ?? ''
    );
    record('empty-state.copy', { text }, (v) =>
      v.text.includes("No worktrees yet — create one from the composer's Mode chip.")
    );
    const cardCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="worktree-map-card"]').length
    );
    record('empty-state.no-cards', { cardCount }, (v) => v.cardCount === 0);
  },

  /** Brief Step 2, check 5 — gh absent from PATH. Requires --repo, and the
   * caller must have relaunched dev:agent-debug with `gh` NOT resolvable on
   * PATH (a shimmed `gh` deleted from the process's PATH cannot be simulated
   * by removing a file mid-session — PATH is fixed at Electron's own launch —
   * so this probe is meant to run against a SEPARATE agent-debug session). */
  async 'gh-absent'(page) {
    await seedRootByPath(page, repoPath);
    await openWorktreeMapTab(page);
    const cardCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="worktree-map-card"]').length
    );
    record('gh-absent.map-still-renders-every-card', { cardCount }, (v) => v.cardCount === 3);
    const prPillPresent = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="worktree-map-card"]')].some((card) =>
        /#\d+/u.test(card.textContent ?? '')
      )
    );
    record('gh-absent.no-pr-pill', { prPillPresent }, (v) => v.prPillPresent === false);

    const prCard = page
      .locator('[data-testid="worktree-map-card"]')
      .filter({ hasText: 'pr-external' });
    await prCard.getByTestId('worktree-map-card-actions').click();
    await page.getByRole('menuitem', { exact: true, name: 'Adopt' }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="worktree-map-card"]')]
          .find((card) => card.textContent?.includes('pr-external'))
          ?.querySelector('[data-testid="worktree-map-new-thread"]')
          ?.hasAttribute('disabled') === false,
      { timeout: 30_000 }
    );
    await prCard.getByTestId('worktree-map-new-thread').click();
    // Two `workspace-bar-branch-chip` elements exist at this point (one per
    // open thread tab, matching the exact strict-mode shape BST-1392's own
    // W5 desktop e2e hit and fixed in worktree-map.desktop.test.ts) — scope
    // to the one that's actually visible.
    const branchChipLocator = page
      .getByTestId('workspace-bar-branch-chip')
      .filter({ visible: true });
    await branchChipLocator.waitFor({ timeout: 30_000 });
    const branchChipAriaLabel = await branchChipLocator.getAttribute('aria-label');
    record('gh-absent.branch-chip-states-reason', { ariaLabel: branchChipAriaLabel }, (v) =>
      (v.ariaLabel ?? '').includes('PR status unavailable —')
    );
  },

  /** Brief Step 2, check 6. Requires --repo. Uses the PRIMARY card, which
   * always has a `rootId` (it is the already-open workspace root) and so
   * always renders an indexing badge — unlike a worktree freshly mounted by
   * `onNewThread` in THIS session: mounting a NEW root via
   * `addRootDirectoryByPath` does not itself refresh the Map's own card list
   * the way `onAdopt`'s explicit `void refresh()` does (found live: after
   * `pr-pill` adopts AND mounts `pr-external`, its card still reports
   * `indexing: 'not-a-root'` — no indexing button at all — until some
   * UNRELATED changes-invalidation event refreshes the Map). That is a real,
   * narrow timing gap worth a follow-up, not a reason to route this check
   * through it: the primary card exercises the exact same toggle claim
   * without depending on that unrelated flow's timing. */
  async 'indexing-toggle'(page) {
    await openWorktreeMapTab(page);
    const card = page.locator('[data-testid="worktree-map-card"]').first();
    const badgeButton = card.getByTestId('worktree-map-indexing');
    if ((await badgeButton.getAttribute('aria-pressed')) === 'true') {
      await badgeButton.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="worktree-map-indexing"]')
            ?.getAttribute('aria-pressed') === 'false'
      );
    }
    const before = await badgeButton.getAttribute('aria-label');
    await badgeButton.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="worktree-map-indexing"]')
          ?.getAttribute('aria-pressed') === 'true'
    );
    const after = await badgeButton.getAttribute('aria-label');
    record('indexing-toggle.badge-flips', { after, before }, (v) => v.before !== v.after);

    // The store persists through `window.electronAPI.storage` (main-process
    // storage), not `localStorage` — `getElectronStorageBridge()` prefers it
    // whenever Electron's bridge exists (background-indexing-preferences-
    // store.ts). Reading `localStorage` here found nothing (verified live) —
    // `seed-root.ts`'s E2E helper writes the SAME key to `localStorage`
    // directly for the DIFFERENT purpose of pre-seeding before the app ever
    // boots, which is not the same as where the running store persists to.
    const persisted = await page.evaluate(async () => {
      const raw = await globalThis.electronAPI?.storage?.getItem?.(
        'background-indexing-preferences.v1'
      );
      return raw ? JSON.parse(raw) : {};
    });
    const optInIds = Object.keys(persisted?.state?.worktreeRootIndexingOptInById ?? {});
    record(
      'indexing-toggle.persisted-store-gains-root-id',
      { optInIds },
      (v) => v.optInIds.length > 0
    );
  },

  /** Task 7 Step 7, check 4 — live refresh with no page reload. Requires --repo. */
  async 'live-refresh'(page, { touchGitHead }) {
    await openWorktreeMapTab(page);
    const beforeCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="worktree-map-card"]').length
    );
    await page.evaluate(() => {
      globalThis.__cdtLiveRefreshMarker = 'still-here';
    });
    await touchGitHead();
    await page.waitForTimeout(2500); // clears the fs-watcher's 300-2000ms coalescing window
    const afterCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="worktree-map-card"]').length
    );
    const markerSurvived = await page.evaluate(
      () => globalThis.__cdtLiveRefreshMarker === 'still-here'
    );
    record(
      'live-refresh.no-reload-count-stable',
      { afterCount, beforeCount, markerSurvived },
      (v) => v.markerSurvived === true && v.afterCount === v.beforeCount
    );
  },

  /** Brief Step 2, checks 2-3; Task 7 Step 7, checks 2-3. Requires --repo. */
  async 'map-cards'(page) {
    await seedRootByPath(page, repoPath);
    await openWorktreeMapTab(page);
    const cards = await readCards(page);
    record('map-cards.count', { count: cards.length }, (v) => v.count === 3);

    const primary = cards[0];
    record(
      'map-cards.primary-first-and-disabled',
      { primary },
      (v) =>
        v.primary?.provenanceLabel === 'Primary checkout' && v.primary?.newThreadDisabled === true
    );

    const locked = cards.find((card) => (card.disabledReasonText ?? '').startsWith('Locked: '));
    record(
      'map-cards.locked-worktree',
      { locked },
      (v) =>
        v.locked !== undefined &&
        v.locked.newThreadDisabled === true &&
        v.locked.newThreadTitle === v.locked.disabledReasonText
    );

    const first = cards[0];
    record(
      'map-cards.first-card-fields',
      { first },
      (v) =>
        v.first !== undefined &&
        typeof v.first.name === 'string' &&
        v.first.name.length > 0 &&
        v.first.rect.width > 0 &&
        v.first.rect.height > 0
    );
  },

  /** Brief Step 2, check 7; Task 7 Step 7, check 5. Requires --repo. */
  async 'narrow-pane'(page) {
    await openWorktreeMapTab(page);
    await page.setViewportSize({ height: 900, width: 1440 });
    const wide = await readLaneMetrics(page);
    record(
      'narrow-pane.wide-body-no-overflow',
      wide,
      (v) => v.bodyScrollWidth === v.bodyClientWidth
    );

    await page.setViewportSize({ height: 900, width: 420 });
    const narrow = await readLaneMetrics(page);
    record(
      'narrow-pane.rows-fit-narrow',
      narrow,
      (v) => v.lanes.length > 0 && v.lanes.every((lane) => lane.scrollWidth <= lane.clientWidth + 1)
    );
    record(
      'narrow-pane.narrow-body-no-overflow',
      narrow,
      (v) => v.bodyScrollWidth === v.bodyClientWidth
    );
    await page.setViewportSize({ height: 900, width: 1440 });
  },

  /** BST-1457 Step 1 — Open in Terminal pins the panel to the card's checkout.
   * Requires --repo. Uses the PRIMARY card, which always has a `rootId` (it is
   * the seeded workspace root), so the probe never depends on an adoption
   * having happened first. Reports COMPUTED VALUES: whether the item exists,
   * the panel's rendered header text, and the release control's rect. */
  async 'open-terminal'(page) {
    await seedRootByPath(page, repoPath);
    await openWorktreeMapTab(page);

    const primaryCard = page.locator('[data-testid="worktree-map-card"]').first();
    await primaryCard.getByTestId('worktree-map-card-actions').click();
    const item = page.getByRole('menuitem', { exact: true, name: 'Open in Terminal' });
    const itemCount = await item.count();
    record('open-terminal.item-present', { itemCount }, (v) => v.itemCount === 1);
    if (itemCount !== 1) {
      await page.keyboard.press('Escape');
      return;
    }
    await item.click();

    await page.waitForSelector('[data-testid="terminal-panel"]', { timeout: 30_000 });
    const panel = await read(page, '[data-testid="terminal-panel"]');
    const expectedBasename = repoPath.split('/').filter(Boolean).at(-1) ?? null;
    record(
      'open-terminal.panel-shows-checkout-cwd',
      { expectedBasename, text: panel?.text ?? null },
      // An unresolvable basename FAILS the check; it never falls back to a
      // sentinel that could make an empty panel read as a pass.
      (v) => v.expectedBasename !== null && (v.text ?? '').includes(v.expectedBasename)
    );

    const release = await read(page, '[data-testid="terminal-panel-clear-target"]');
    record(
      'open-terminal.release-control-is-real',
      release,
      (v) => v !== null && v.disabled === false && v.width > 0 && v.height > 0
    );

    await page.click('[data-testid="terminal-panel-clear-target"]');
    const afterRelease = await read(page, '[data-testid="terminal-panel-clear-target"]');
    record(
      'open-terminal.release-clears-the-pin',
      { afterRelease },
      (v) => v.afterRelease === null
    );
  },

  /** Brief Step 2, check 4 — the PR pill vs. the thread-list pill. Requires --repo
   * (the worktree named `pr` in the seeded topology) and a `gh` on PATH primed
   * with an open PR for that branch. */
  async 'pr-pill'(page) {
    await openWorktreeMapTab(page);
    const prCardActions = page
      .locator('[data-testid="worktree-map-card"]')
      .filter({ hasText: 'pr-external' })
      .getByTestId('worktree-map-card-actions');
    await prCardActions.click();
    await page.getByRole('menuitem', { exact: true, name: 'Adopt' }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="worktree-map-card"]')]
          .find((card) => card.textContent?.includes('pr-external'))
          ?.querySelector('[data-testid="worktree-map-new-thread"]')
          ?.hasAttribute('disabled') === false,
      { timeout: 30_000 }
    );
    const newThread = page
      .locator('[data-testid="worktree-map-card"]')
      .filter({ hasText: 'pr-external' })
      .getByTestId('worktree-map-new-thread');
    await newThread.click();
    await page.waitForSelector('[data-testid="workspace-bar-pr-chip"]', { timeout: 30_000 });
    const chip = await read(page, '[data-testid="workspace-bar-pr-chip"]');
    record('pr-pill.thread-list-chip', chip, (v) => /#\d+/u.test(v?.text ?? ''));

    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="worktree-map-card"]')]
          .find((card) => card.textContent?.includes('pr-external'))
          ?.textContent?.match(/#\d+/u) !== null,
      { timeout: 30_000 }
    );
    const cards = await readCards(page);
    const prCard = cards.find((card) => card.name === 'pr-external');
    const chipDataChecks = await page.getAttribute(
      '[data-testid="workspace-bar-pr-chip"]',
      'data-checks'
    );
    // Both surfaces read the SAME `pullRequest.checksRollup` field from the
    // shared PR cache (pr-chip.tsx's `data-checks`; worktree-map-card.tsx's
    // `#{number} {checksRollup}` text) — assert the two are ACTUALLY equal
    // (the "cannot disagree" claim from A2), not just that both look present.
    record(
      'pr-pill.map-agrees-with-thread-list',
      { chipDataChecks, chipNumber: chip?.text?.match(/#\d+/u)?.[0], prCard },
      (v) => v.prCard?.prPillText === `${v.chipNumber} ${v.chipDataChecks}`
    );
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

// Run order is EXPLICIT, not the literal's order: Biome's useSortedKeys keeps
// the `probes` literal alphabetical, and alphabetical is not a valid run
// order — `add-menu` and `empty-state` must run before any probe seeds a
// root. The parity check below makes drift (a probe added to one list but
// not the other) a hard exit, not a silent no-op.
const RUN_ORDER = [
  'add-menu',
  'empty-state',
  'card-colors',
  'gh-absent',
  'indexing-toggle',
  'live-refresh',
  'map-cards',
  'narrow-pane',
  'open-terminal',
  'pr-pill',
];
if ([...RUN_ORDER].sort().join(',') !== Object.keys(probes).sort().join(',')) {
  process.stderr.write('RUN_ORDER and the probes object have drifted apart; fix the script.\n');
  process.exit(2);
}

// A selection that cannot run must fail LOUDLY before touching the browser:
// a run that executed no verification reporting `failures: 0` reads as a
// passing CDT check (the instrument-that-cannot-fail trap).
const REPO_EXEMPT_PROBES = new Set(['add-menu', 'empty-state']);
if (requested && !Object.hasOwn(probes, requested)) {
  process.stderr.write(
    `Unknown probe "${requested}". Known probes: ${Object.keys(probes).join(', ')}.\n`
  );
  process.exit(2);
}
if (requested && !REPO_EXEMPT_PROBES.has(requested) && !repoPath) {
  process.stderr.write(`Probe "${requested}" requires --repo <path>.\n`);
  process.exit(2);
}

const browser = await chromium.connectOverCDP(ENDPOINT);
const context = browser.contexts()[0];
const page = await findMainPage(context);
if (!page) {
  process.stderr.write(
    'No renderer page rendering the workspace bar was found on the CDP endpoint. ' +
      'Run `pnpm --filter @brainstrike/desktop dev:agent-debug` first.\n'
  );
  await browser.close();
  process.exit(2);
}

const { execFileSync } = await import('node:child_process');
async function touchGitHead() {
  execFileSync('git', ['commit', '--allow-empty', '-m', 'cdt-verify live-refresh probe'], {
    cwd: repoPath,
  });
}

const skipped = [];
for (const name of RUN_ORDER) {
  const probe = probes[name];
  if (requested && requested !== name) {
    continue;
  }
  if (!(REPO_EXEMPT_PROBES.has(name) || repoPath)) {
    // Only reachable in a full (no `--probe`) run — an explicit selection
    // without `--repo` already exited 2 above. Skips stay visible in the
    // JSON so "0 failures" cannot be mistaken for "everything ran".
    process.stderr.write(`Probe "${name}" requires --repo <path>; skipping.\n`);
    skipped.push(name);
    continue;
  }
  await probe(page, { touchGitHead });
}

process.stdout.write(`${JSON.stringify({ failures, results, skipped }, null, 2)}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
