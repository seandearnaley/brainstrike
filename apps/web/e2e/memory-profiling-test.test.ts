import { expect, test } from '@playwright/test';
import { waitForAppLoad } from './utils/layout-helpers';

declare global {
  interface Window {
    __memoryProfiler: {
      snapshots: Array<{
        label: string;
        timestamp: number;
        usedMB: number;
        totalMB: number;
        domNodes: number;
        reactComponents: number;
        canvasElements: number;
        imgElements: number;
        svgElements: number;
      }>;
      tracking: boolean;
      start: () => void;
      takeSnapshot: (label: string) => void;
      getAnalysis: () =>
        | {
            memoryGrowthMB: number;
            domNodeGrowth: number;
            reactComponentGrowth: number;
            canvasGrowth: number;
            imgGrowth: number;
            svgGrowth: number;
            snapshots: Window['__memoryProfiler']['snapshots'];
          }
        | { error: string };
    };
    gc?: () => void;
  }
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
  };
}

test.describe('Memory Profiling - Find Real Memory Growth Source', () => {
  test('profile memory growth to identify actual sources', async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);

    // Install comprehensive memory profiler
    await page.evaluate(() => {
      // Memory profiler directly in browser
      window.__memoryProfiler = {
        snapshots: [],
        tracking: false,

        start: () => {
          window.__memoryProfiler.tracking = true;
          window.__memoryProfiler.snapshots = [];
          window.__memoryProfiler.takeSnapshot('initial');
        },

        takeSnapshot: (label: string) => {
          const memory = (performance as PerformanceWithMemory).memory;
          if (!memory) return;

          const snapshot = {
            label,
            timestamp: Date.now(),
            usedMB: Math.round(memory.usedJSHeapSize / 1024 / 1024),
            totalMB: Math.round(memory.totalJSHeapSize / 1024 / 1024),
            domNodes: document.querySelectorAll('*').length,
            // Try to track potential memory sources
            reactComponents: document.querySelectorAll(
              '[data-reactroot], [data-react-], [class*="react-"]'
            ).length,
            canvasElements: document.querySelectorAll('canvas').length,
            imgElements: document.querySelectorAll('img').length,
            svgElements: document.querySelectorAll('svg').length,
            iframes: document.querySelectorAll('iframe').length,
          };

          window.__memoryProfiler.snapshots.push(snapshot);
          console.log(`📊 Memory snapshot [${label}]:`, snapshot);
        },

        getAnalysis: () => {
          const snapshots = window.__memoryProfiler.snapshots;
          if (snapshots.length < 2) return { error: 'Need at least 2 snapshots' };

          const first = snapshots[0];
          const last = snapshots[snapshots.length - 1];

          return {
            memoryGrowthMB: last.usedMB - first.usedMB,
            domNodeGrowth: last.domNodes - first.domNodes,
            reactComponentGrowth: last.reactComponents - first.reactComponents,
            canvasGrowth: last.canvasElements - first.canvasElements,
            imgGrowth: last.imgElements - first.imgElements,
            svgGrowth: last.svgElements - first.svgElements,
            snapshots: snapshots,
          };
        },
      };
    });

    console.log('🧪 Starting comprehensive memory profiling...');

    // Start profiling
    await page.evaluate(() => window.__memoryProfiler.start());

    // Take baseline
    await page.evaluate(() => window.__memoryProfiler.takeSnapshot('baseline'));

    // Look for folder selection button
    const selectButton = page
      .locator('button', { hasText: 'Select Root' })
      .or(page.locator('[data-testid="select-root-button"]'))
      .or(page.locator('button:has-text("folder")'));

    if ((await selectButton.count()) > 0) {
      console.log('📁 Testing folder selection memory impact...');

      await page.evaluate(() => window.__memoryProfiler.takeSnapshot('before-folder-click'));

      await selectButton.first().click();
      await page.waitForTimeout(2000); // Wait for any loading

      await page.evaluate(() => window.__memoryProfiler.takeSnapshot('after-folder-click'));
    }

    // Test general UI interactions that might cause memory growth
    console.log('🖱️ Testing UI interaction memory impact...');

    const clickableElements = page.locator('button, [role="button"], a, input, [data-testid]');
    const elementCount = Math.min(10, await clickableElements.count());

    for (let i = 0; i < elementCount; i++) {
      try {
        await page.evaluate(
          (index) => window.__memoryProfiler.takeSnapshot(`before-interaction-${index}`),
          i
        );

        const element = clickableElements.nth(i);
        const tagName = await element.evaluate((el) => el.tagName?.toLowerCase() || '');

        if (tagName === 'input') {
          await element.fill(`test-value-${i}`, { timeout: 1000 });
        } else {
          await element.click({ timeout: 1000 });
        }

        await page.waitForTimeout(200);

        await page.evaluate(
          (index) => window.__memoryProfiler.takeSnapshot(`after-interaction-${index}`),
          i
        );
      } catch (e) {
        console.log(`⚠️ Skipped interaction ${i}: ${e}`);
      }
    }

    // Force garbage collection
    await page.evaluate(() => {
      if (window.gc) {
        window.gc();
      }
    });

    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__memoryProfiler.takeSnapshot('after-gc'));

    // Get comprehensive analysis
    const analysis = await page.evaluate(() => window.__memoryProfiler.getAnalysis());

    console.log('📊 MEMORY PROFILING ANALYSIS:');
    console.log(`  Total Memory Growth: ${analysis.memoryGrowthMB}MB`);
    console.log(`  DOM Node Growth: ${analysis.domNodeGrowth} nodes`);
    console.log(`  React Component Growth: ${analysis.reactComponentGrowth} components`);
    console.log(`  Canvas Element Growth: ${analysis.canvasGrowth} elements`);
    console.log(`  Image Element Growth: ${analysis.imgGrowth} elements`);
    console.log(`  SVG Element Growth: ${analysis.svgGrowth} elements`);

    // Analyze snapshot progression
    console.log('\n📈 Memory Growth Progression:');
    for (let i = 1; i < analysis.snapshots.length; i++) {
      const prev = analysis.snapshots[i - 1];
      const curr = analysis.snapshots[i];
      const growthMB = curr.usedMB - prev.usedMB;

      if (Math.abs(growthMB) > 5) {
        // Only log significant changes
        console.log(`  ${prev.label} → ${curr.label}: ${growthMB > 0 ? '+' : ''}${growthMB}MB`);
      }
    }

    // Find the biggest memory jumps
    let biggestJump = {
      growth: 0,
      from: '',
      to: '',
      details: {
        domNodeChange: 0,
        reactComponentChange: 0,
      },
    };
    for (let i = 1; i < analysis.snapshots.length; i++) {
      const prev = analysis.snapshots[i - 1];
      const curr = analysis.snapshots[i];
      const growth = curr.usedMB - prev.usedMB;

      if (growth > biggestJump.growth) {
        biggestJump = {
          growth,
          from: prev.label,
          to: curr.label,
          details: {
            domNodeChange: curr.domNodes - prev.domNodes,
            reactComponentChange: curr.reactComponents - prev.reactComponents,
          },
        };
      }
    }

    console.log('\n🎯 BIGGEST MEMORY JUMP:');
    console.log(`  ${biggestJump.from} → ${biggestJump.to}: +${biggestJump.growth}MB`);
    console.log(`  DOM nodes changed: ${biggestJump.details.domNodeChange}`);
    console.log(`  React components changed: ${biggestJump.details.reactComponentChange}`);

    // Specific analysis for common memory leak sources
    console.log('\n🔍 POTENTIAL MEMORY LEAK SOURCES:');

    if (analysis.domNodeGrowth > 1000) {
      console.log(`  ⚠️ HIGH DOM GROWTH: ${analysis.domNodeGrowth} nodes (possible DOM leak)`);
    }

    if (analysis.reactComponentGrowth > 100) {
      console.log(
        `  ⚠️ HIGH REACT GROWTH: ${analysis.reactComponentGrowth} components (possible React leak)`
      );
    }

    const memoryPerDomNode =
      analysis.domNodeGrowth > 0 ? analysis.memoryGrowthMB / analysis.domNodeGrowth : 0;
    if (memoryPerDomNode > 0.1) {
      console.log(
        `  ⚠️ HIGH MEMORY PER DOM NODE: ${memoryPerDomNode.toFixed(3)}MB per node (possible large objects)`
      );
    }

    // Save detailed analysis for later review
    await page.evaluate((data) => {
      localStorage.setItem('memoryAnalysis', JSON.stringify(data));
    }, analysis);

    console.log('\n✅ Memory profiling complete. Analysis saved to localStorage.');

    // The test passes if we collected data - the goal is profiling, not strict limits
    expect(analysis.snapshots.length).toBeGreaterThan(1);
    expect(analysis.memoryGrowthMB).toBeDefined();
  });
});
