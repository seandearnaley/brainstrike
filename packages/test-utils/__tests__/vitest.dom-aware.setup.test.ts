import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domAwareSetup = path.join(packageRoot, 'src', 'vitest.dom-aware.setup.ts');
const domAwareTimeoutsSetup = path.join(packageRoot, 'src', 'vitest.dom-aware-timeouts.setup.ts');
const vitestBin = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');

interface FixtureRun {
  code: number | null;
  output: string;
  report: {
    testResults: Array<{
      assertionResults: Array<{ failureMessages: string[]; status: string; title: string }>;
      message: string;
      name: string;
      status: string;
    }>;
  };
}

function runFixture(dir: string, setupFile: string): Promise<FixtureRun> {
  const config = path.join(dir, 'vitest.fixture.config.mjs');
  writeFileSync(
    config,
    `export default { test: { environment: 'node', globals: true, include: ['*.test.mjs'], setupFiles: [${JSON.stringify(setupFile)}] } };\n`
  );
  const reportPath = path.join(dir, 'report.json');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestBin,
        'run',
        '--root',
        dir,
        '--config',
        config,
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, TEST_TIMEOUT_MULTIPLIER: '3' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      try {
        resolve({ code, output, report: JSON.parse(readFileSync(reportPath, 'utf8')) });
      } catch (error) {
        reject(
          new Error(`fixture run left no JSON report (exit ${code}):\n${output}`, { cause: error })
        );
      }
    });
  });
}

function resultFor(run: FixtureRun, fileName: string) {
  const result = run.report.testResults.find((entry) => path.basename(entry.name) === fileName);
  if (!result) {
    throw new Error(`no result for ${fileName}:\n${run.output}`);
  }
  return result;
}

describe('vitest.dom-aware.setup', () => {
  it('loads the DOM half only in DOM environments and makes node-environment DOM testing fail loudly', async () => {
    // Inside the package so the fixtures' bare imports resolve; removed in finally.
    const dir = mkdtempSync(path.join(packageRoot, '.dom-aware-fixture-'));
    try {
      writeFileSync(
        path.join(dir, 'dom.test.mjs'),
        `// @vitest-environment happy-dom
import { getConfig } from '@testing-library/dom';
import { expect, it, vi } from 'vitest';

it('registers jest-dom matchers, the scaled async-util budget and the window mocks', () => {
  document.body.innerHTML = '<p>hello</p>';
  expect(document.querySelector('p')).toBeInTheDocument();
  expect(getConfig().asyncUtilTimeout).toBe(3000);
  expect(vi.isMockFunction(window.matchMedia)).toBe(true);
  expect(globalThis.IS_REACT_ACT_ENVIRONMENT).toBe(true);
});
`
      );
      writeFileSync(
        path.join(dir, 'node-logic.test.mjs'),
        `import { expect, it, vi } from 'vitest';

it('keeps the environment-independent hooks: fake timers left on by one test', () => {
  vi.useFakeTimers();
  expect(typeof document).toBe('undefined');
  expect(globalThis.IS_REACT_ACT_ENVIRONMENT).toBe(true);
});

it('are restored before the next test', () => {
  expect(vi.isFakeTimers()).toBe(false);
});
`
      );
      writeFileSync(
        path.join(dir, 'node-matcher.test.mjs'),
        `import { expect, it } from 'vitest';

it('uses a jest-dom matcher without a DOM', () => {
  expect({}).toBeInTheDocument();
});
`
      );
      writeFileSync(
        path.join(dir, 'node-screen.test.mjs'),
        `import { screen } from '@testing-library/dom';
import { it } from 'vitest';

it('queries the screen without a DOM', () => {
  screen.getByText('hello');
});
`
      );

      const run = await runFixture(dir, domAwareSetup);

      expect(resultFor(run, 'dom.test.mjs').status, run.output).toBe('passed');
      expect(resultFor(run, 'node-logic.test.mjs').status, run.output).toBe('passed');

      const matcher = resultFor(run, 'node-matcher.test.mjs');
      expect(matcher.status).toBe('failed');
      expect(matcher.assertionResults[0]?.failureMessages.join('\n')).toMatch(
        /Invalid Chai property: toBeInTheDocument/u
      );

      const screen = resultFor(run, 'node-screen.test.mjs');
      expect(screen.status).toBe('failed');
      expect(screen.assertionResults[0]?.failureMessages.join('\n')).toMatch(
        /global document has to be available/u
      );
      expect(run.code).not.toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 120_000);
});

describe('vitest.dom-aware-timeouts.setup', () => {
  it('scales the async-util budget in DOM environments and leaves node files unconfigured', async () => {
    const dir = mkdtempSync(path.join(packageRoot, '.dom-aware-fixture-'));
    try {
      writeFileSync(
        path.join(dir, 'dom.test.mjs'),
        `// @vitest-environment happy-dom
import { getConfig } from '@testing-library/dom';
import { expect, it } from 'vitest';

it('scales the budget', () => {
  expect(getConfig().asyncUtilTimeout).toBe(3000);
});
`
      );
      writeFileSync(
        path.join(dir, 'node.test.mjs'),
        `import { expect, it } from 'vitest';

it('runs without a DOM', () => {
  expect(typeof document).toBe('undefined');
});
`
      );

      const run = await runFixture(dir, domAwareTimeoutsSetup);

      expect(resultFor(run, 'dom.test.mjs').status, run.output).toBe('passed');
      expect(resultFor(run, 'node.test.mjs').status, run.output).toBe('passed');
      expect(run.code, run.output).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 120_000);
});
