import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { MemoryAnalysis, MemorySnapshot } from '../types/performance';
import { waitForAppLoad } from '../utils/layout-helpers';

test.describe('Memory Profiling - Find Real Memory Growth Source', () => {
  // Helper function to install memory profiler
  async function installMemoryProfiler(page: Page): Promise<void> {
    await page.evaluate(() => {
      // Memory profiler directly in browser
      window.__memoryProfiler = {
        snapshots: [],
        tracking: false,

        start: () => {
          if (window.__memoryProfiler) {
            window.__memoryProfiler.tracking = true;
            window.__memoryProfiler.snapshots = [];
            window.__memoryProfiler.takeSnapshot('initial');
          }
        },

        takeSnapshot: (label: string) => {
          const memory = performance.memory;
          if (!(memory && window.__memoryProfiler)) {
            return;
          }

          const snapshot: MemorySnapshot = {
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
          if (!window.__memoryProfiler) {
            return { error: 'Memory profiler not available' };
          }

          const snapshots = window.__memoryProfiler.snapshots;
          if (snapshots.length < 2) {
            return { error: 'Need at least 2 snapshots' };
          }

          const first = snapshots[0];
          const last = snapshots.at(-1);

          if (!(first && last)) {
            return { error: 'Missing snapshot data' };
          }

          return {
            memoryGrowthMB: last.usedMB - first.usedMB,
            domNodeGrowth: last.domNodes - first.domNodes,
            reactComponentGrowth: last.reactComponents - first.reactComponents,
            canvasGrowth: last.canvasElements - first.canvasElements,
            imgGrowth: last.imgElements - first.imgElements,
            svgGrowth: last.svgElements - first.svgElements,
            snapshots,
          };
        },
      };
    });
  }

  // Helper function to test folder selection memory impact
  async function testFolderSelectionMemory(page: Page): Promise<void> {
    const selectButton = page
      .locator('button', { hasText: 'Add Folder to Workspace' })
      .or(page.locator('[data-testid="select-root-button"]'))
      .or(page.locator('button:has-text("folder")'));

    if ((await selectButton.count()) > 0) {
      console.log('📁 Testing folder selection memory impact...');

      await page.evaluate(() => window.__memoryProfiler?.takeSnapshot('before-folder-click'));

      await selectButton.first().click();
      await page.waitForTimeout(2000); // Wait for any loading

      await page.evaluate(() => window.__memoryProfiler?.takeSnapshot('after-folder-click'));
    }
  }

  // Helper function to test UI interactions memory impact
  async function testUIInteractionsMemory(page: Page): Promise<void> {
    console.log('🖱️ Testing UI interaction memory impact...');

    const clickableElements = page.locator('button, [role="button"], a, input, [data-testid]');
    const elementCount = Math.min(10, await clickableElements.count());

    for (let i = 0; i < elementCount; i++) {
      try {
        await page.evaluate(
          (index) => window.__memoryProfiler?.takeSnapshot(`before-interaction-${index}`),
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
          (index) => window.__memoryProfiler?.takeSnapshot(`after-interaction-${index}`),
          i
        );
      } catch (e) {
        console.log(`⚠️ Skipped interaction ${i}: ${e}`);
      }
    }
  }

  // Helper function to force garbage collection and analyze results
  async function analyzeMemoryResults(page: Page): Promise<MemoryAnalysis> {
    // Force garbage collection
    await page.evaluate(() => {
      if (window.gc) {
        window.gc();
      }
    });

    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__memoryProfiler?.takeSnapshot('after-gc'));

    // Get comprehensive analysis
    const analysis = await page.evaluate(() => window.__memoryProfiler?.getAnalysis());

    if (!analysis || 'error' in analysis) {
      throw new Error(analysis?.error || 'Failed to get memory analysis');
    }

    return analysis;
  }

  // Helper function to log memory analysis
  function logMemoryAnalysis(analysis: MemoryAnalysis): void {
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
      if (!(prev && curr)) {
        continue;
      }
      const growthMB = curr.usedMB - prev.usedMB;

      if (Math.abs(growthMB) > 5) {
        // Only log significant changes
        console.log(`  ${prev.label} → ${curr.label}: ${growthMB > 0 ? '+' : ''}${growthMB}MB`);
      }
    }

    // Find and log biggest memory jump
    logBiggestMemoryJump(analysis);

    // Log potential memory leak sources
    logPotentialMemoryLeaks(analysis);
  }

  // Helper function to find and log the biggest memory jump
  function logBiggestMemoryJump(analysis: MemoryAnalysis): void {
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
      if (!(prev && curr)) {
        continue;
      }
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
  }

  // Helper function to log potential memory leaks
  function logPotentialMemoryLeaks(analysis: MemoryAnalysis): void {
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
  }

  test('profile memory growth to identify actual sources', async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);

    // Install comprehensive memory profiler
    await installMemoryProfiler(page);

    console.log('🧪 Starting comprehensive memory profiling...');

    // Start profiling
    await page.evaluate(() => window.__memoryProfiler?.start());

    // Take baseline
    await page.evaluate(() => window.__memoryProfiler?.takeSnapshot('baseline'));

    // Test folder selection memory impact
    await testFolderSelectionMemory(page);

    // Test UI interactions memory impact
    await testUIInteractionsMemory(page);

    // Analyze memory results
    const analysis = await analyzeMemoryResults(page);

    // Log comprehensive analysis
    logMemoryAnalysis(analysis);

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
