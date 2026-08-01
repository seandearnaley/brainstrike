import { expect, type Page, test } from '@playwright/test';

interface BoxEdges {
  readonly bottom: number;
  readonly height: number;
  readonly top: number;
}

const RELEASE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_COMMIT = 'b'.repeat(40);
const RELEASE_BASE = 'https://downloads.example.com/brainstrike/';

function releaseAsset(
  name: string,
  platform: 'linux' | 'macos' | 'windows',
  architecture: 'arm64' | 'x64',
  packageName: 'appimage' | 'dmg' | 'nsis'
) {
  return {
    architecture,
    digest: RELEASE_DIGEST,
    name,
    package: packageName,
    platform,
    sizeBytes: 125_400_000,
    url: `${RELEASE_BASE}v1.0.0/${name}`,
  } as const;
}

const PUBLISHED_MANIFEST = {
  channel: 'stable',
  distribution: {
    artifactBaseUrl: RELEASE_BASE,
    releasesHubUrl: 'https://downloads.example.com/brainstrike/releases',
  },
  latest: {
    assets: [
      releaseAsset('Brainstrike-1.0.0-macos-arm64.dmg', 'macos', 'arm64', 'dmg'),
      releaseAsset('Brainstrike-1.0.0-macos-x64.dmg', 'macos', 'x64', 'dmg'),
      releaseAsset('Brainstrike-1.0.0-windows-x64.exe', 'windows', 'x64', 'nsis'),
      releaseAsset('Brainstrike-1.0.0-linux-x64.AppImage', 'linux', 'x64', 'appimage'),
    ],
    publishedAt: '2026-08-01T00:00:00Z',
    sourceCommit: RELEASE_COMMIT,
    tag: 'v1.0.0',
    version: '1.0.0',
  },
  product: 'Brainstrike',
  schemaVersion: 2,
} as const;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function boxEdges(page: Page, selector: string): Promise<BoxEdges> {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, height: rect.height, top: rect.top };
  });
}

async function waitForSettledScroll(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let previous = window.scrollY;
        let stableFrames = 0;
        const sample = (): void => {
          const current = window.scrollY;
          stableFrames = Math.abs(current - previous) <= 0.5 ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 4) {
            resolve();
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      })
  );
}

test('renders the complete product journey without horizontal overflow', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Intelligence');
  await expect(page.locator('[data-scene-anchor]')).toHaveCount(8);
  await expect(page.locator('footer')).toBeAttached();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('Resolve navigation is deterministic and the final frame remains composed', async ({
  page,
}) => {
  await page.setViewportSize({ height: 568, width: 320 });
  await page.goto('/');
  const scrollSamples: number[] = [];

  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => {
      window.location.hash = 'download';
    });
    await expect(page).toHaveURL(/#download$/);
    await waitForSettledScroll(page);
    scrollSamples.push(await page.evaluate(() => window.scrollY));
    if (index < 2) {
      await page.evaluate(() => {
        window.location.hash = 'signal';
      });
      await waitForSettledScroll(page);
    }
  }

  expect(Math.max(...scrollSamples) - Math.min(...scrollSamples)).toBeLessThanOrEqual(1);

  const frame = await boxEdges(page, '#download');
  const intro = await boxEdges(page, '.closing-intro');
  const dock = await boxEdges(page, '#download .download-chooser-terminal');
  const footer = await boxEdges(page, '#download .site-footer');
  const viewportHeight = await page.evaluate(() => window.innerHeight);

  expect(frame.top).toBeGreaterThanOrEqual(-1);
  expect(frame.bottom).toBeLessThanOrEqual(viewportHeight + 1);
  expect(intro.bottom).toBeLessThanOrEqual(dock.top);
  expect(dock.bottom).toBeLessThanOrEqual(footer.top + 1);
  expect(footer.bottom).toBeLessThanOrEqual(viewportHeight + 1);
});

test('the final frame tolerates expanded localized copy without overlap', async ({ page }) => {
  await page.setViewportSize({ height: 568, width: 320 });
  await page.goto('/#download');
  await page.locator('.closing h2').evaluate((heading) => {
    heading.innerHTML = 'Brainstrike arbeitet vollständig<br><em>auf Ihrem eigenen Gerät.</em>';
  });
  await page.locator('.closing-intro > p:last-child').evaluate((paragraph) => {
    paragraph.textContent =
      'Arbeitsbereich, Gesprächsverläufe, Indizes, wiederverwendbare Eingabevorlagen, Werkzeuge und dauerhafte Kontinuität bleiben genau dort, wo die Arbeit begonnen hat. Wählen Sie die passende Plattform, sobald eine signierte Veröffentlichung verfügbar ist.';
  });
  await page.locator('.download-status-line span:last-of-type').evaluate((status) => {
    status.textContent =
      'Öffentliche Downloads sind derzeit noch nicht verfügbar. Die signierten Veröffentlichungspakete für alle unterstützten Plattformen sind jedoch bereits vollständig konfiguriert.';
  });
  await page.evaluate(async () => document.fonts.ready);

  const frame = await boxEdges(page, '#download');
  const intro = await boxEdges(page, '.closing-intro');
  const dock = await boxEdges(page, '#download .download-chooser-terminal');
  const footer = await boxEdges(page, '#download .site-footer');
  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

  expect(intro.bottom).toBeLessThanOrEqual(dock.top);
  expect(dock.bottom).toBeLessThanOrEqual(footer.top + 1);
  expect(footer.bottom).toBeLessThanOrEqual(frame.bottom + 1);
  expect(frame.bottom - frame.top).toBeGreaterThan(viewport.height);
  expect(viewport.overflow).toBeLessThanOrEqual(0);

  await page.locator('#download .site-footer').scrollIntoViewIfNeeded();
  await expect(page.locator('#download .site-footer')).toBeInViewport();
});

test('download dialog opens and closes without cumulative layout shift', async ({ page }) => {
  await page.goto('/');
  const download = page.getByRole('button', { name: /download/i });
  const dialog = page.getByRole('dialog');
  const samples: BoxEdges[] = [];

  for (let index = 0; index < 3; index += 1) {
    await download.click();
    await expect(dialog).toBeVisible();
    samples.push(await boxEdges(page, '.download-dialog'));
    await page.getByRole('button', { name: /close download chooser/i }).click();
    await expect(dialog).toBeHidden();
  }

  expect(new Set(samples.map((sample) => JSON.stringify(sample))).size).toBe(1);
});

test('download dialog restores focus and keeps its close control visible while scrolled', async ({
  page,
}) => {
  await page.goto('/');
  const download = page.getByRole('button', { name: /download/i });
  const close = page.getByRole('button', { name: /close download chooser/i });

  await download.click();
  await expect(close).toBeFocused();
  await page.locator('.download-dialog-shell').evaluate((shell) => {
    shell.scrollTop = shell.scrollHeight;
  });
  await expect(close).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(download).toBeFocused();
});

test('published mobile dialog focuses Close and contains forward and reverse tabbing', async ({
  page,
}) => {
  await page.setViewportSize({ height: 568, width: 320 });
  await page.route('**/release-manifest.json', async (route) => {
    await route.fulfill({
      body: JSON.stringify(PUBLISHED_MANIFEST),
      contentType: 'application/json',
    });
  });
  await page.goto('/#download');
  await page
    .locator('#download')
    .getByRole('button', { name: /2 builds/i })
    .click();

  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: /close download chooser/i });
  const finalLink = dialog.getByRole('link', { name: /all release assets/i });
  await expect(close).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(finalLink).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
});

test('download dialog preserves the underlying scroll position', async ({ page }) => {
  await page.goto('/#context');
  await waitForSettledScroll(page);
  const before = await page.evaluate(() => window.scrollY);
  const visualBefore = await boxEdges(page, '#context');

  await page.getByRole('button', { name: /download/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.mouse.wheel(0, 1000);
  await page.waitForTimeout(100);
  const visualWhileLocked = await boxEdges(page, '#context');
  expect(visualWhileLocked.top).toBeCloseTo(visualBefore.top, 0);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});

test('surfaces an explicit visual-engine error when WebGPU is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
  await page.goto('/');

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('WebGPU could not initialize.');
  await expect(alert).toContainText('This browser does not expose WebGPU.');
  const compactHeight = await alert.evaluate((element) => element.getBoundingClientRect().height);
  await alert.getByRole('button', { name: 'Details' }).click();
  await expect(alert.getByRole('link', { name: /check browser support/i })).toBeVisible();
  expect(await alert.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(
    compactHeight
  );
  await alert.getByRole('button', { name: 'Minimize' }).click();
  await expect(alert.getByRole('button', { name: 'Details' })).toBeVisible();
  const topmostClass = await alert.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return topmost?.closest('[role="alert"]')?.className ?? null;
  });
  expect(topmostClass).toContain('gpu-failure');
});

test('never exposes a private repository link while downloads are unpublished', async ({
  page,
}) => {
  await page.goto('/#download');

  await expect(
    page.locator('#download').getByText('Public downloads are not available yet.')
  ).toBeVisible();
  await expect(page.locator('a[href*="seandearnaley/brainstrike"]')).toHaveCount(0);
  await expect(page.getByText('Public release / pending')).toBeVisible();
});

test('renders only manifest-declared assets and bounds multiple builds behind the full chooser', async ({
  page,
}) => {
  await page.route('**/release-manifest.json', async (route) => {
    await route.fulfill({
      body: JSON.stringify(PUBLISHED_MANIFEST),
      contentType: 'application/json',
    });
  });
  await page.goto('/#download');

  await expect(page.locator('#download').getByText('Latest stable build: v1.0.0')).toBeVisible();
  await page
    .locator('#download')
    .getByRole('button', { name: /2 builds/i })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const links = dialog.locator(`.platform-action a[href^="${RELEASE_BASE}"]`);
  await expect(links).toHaveCount(4);
  await expect(dialog.getByText('Apple silicon DMG')).toBeVisible();
  await expect(dialog.getByText('Intel 64-bit DMG')).toBeVisible();
  await expect(dialog.getByText('125 MB').first()).toBeVisible();
});

test('retries a visible manifest error and reaches the validated ready state', async ({ page }) => {
  let attempts = 0;
  await page.route('**/release-manifest.json', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ body: 'unavailable', status: 503 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify(PUBLISHED_MANIFEST),
      contentType: 'application/json',
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /download/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('HTTP 503');

  await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect(dialog.getByRole('status')).toContainText('Latest stable build: v1.0.0');
  expect(attempts).toBe(2);
});

test('revalidates an expired unpublished manifest when the chooser opens', async ({ page }) => {
  await page.clock.install();
  let attempts = 0;
  await page.route('**/release-manifest.json', async (route) => {
    attempts += 1;
    await route.fulfill({
      body: JSON.stringify(
        attempts === 1
          ? {
              channel: 'stable',
              distribution: null,
              latest: null,
              product: 'Brainstrike',
              schemaVersion: 2,
            }
          : PUBLISHED_MANIFEST
      ),
      contentType: 'application/json',
    });
  });
  await page.goto('/#download');
  await expect(
    page.locator('#download').getByText('Public downloads are not available yet.')
  ).toBeVisible();

  await page.clock.fastForward(60_001);
  await page.getByRole('button', { name: 'Download' }).click();

  await expect(page.getByRole('dialog').getByRole('status')).toContainText(
    'Latest stable build: v1.0.0'
  );
  expect(attempts).toBe(2);
});
