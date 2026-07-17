#!/usr/bin/env node
// Lightweight orchestrator for repo checks with timing and clear output.
// Modes:
// - default: install, lint-all, build, type-check, test:coverage:split, coverage:enforce, test:browser, e2e:functional (web), e2e:desktop
// - --fast:   install, lint-all, build, type-check, test:fast, test:browser, e2e:functional (web), e2e:desktop
// - --full:   lint-all, build, type-check, test:coverage:split, coverage:enforce, test:browser, e2e:functional (web), e2e:desktop
// Flags:
//   --no-install     Skip pnpm install
//   --no-e2e         Skip E2E tests
//   --no-coverage    Skip coverage enforcement (only affects default/full modes)
//   --headless       Run headless display setup before checks (Linux CI/dev)
//   --verbose        Show step start/finish banners

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const args = new Set(process.argv.slice(2));
const isFast = args.has('--fast');
const isFull = args.has('--full');
const noInstall = args.has('--no-install');
const noE2E = args.has('--no-e2e');
const noCoverage = args.has('--no-coverage');
const headless = args.has('--headless');
const verbose = args.has('--verbose');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const BLUE = '\u001b[34m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

function banner(msg) {
  if (!verbose) {
    return;
  }
  console.log(`${BLUE}${BOLD}› ${msg}${RESET}`);
}

function stepLabel(cmd) {
  // Short labels for summary
  if (cmd.includes('install')) {
    return 'install';
  }
  if (cmd.includes('lint-all')) {
    return 'lint-all';
  }
  if (cmd === 'pnpm -s run build') {
    return 'build';
  }
  if (cmd === 'pnpm -s run type-check') {
    return 'type-check';
  }
  if (cmd.endsWith('test')) {
    return 'test';
  }
  if (cmd.endsWith('test:fast')) {
    return 'test:fast';
  }
  if (cmd.endsWith('test:coverage:split')) {
    return 'test:coverage:split';
  }
  if (cmd.endsWith('test:browser')) {
    return 'test:browser';
  }
  if (cmd.endsWith('test:e2e:functional')) {
    return 'e2e:functional';
  }
  if (cmd.endsWith('test:e2e:desktop')) {
    return 'e2e:desktop';
  }
  if (cmd.endsWith('setup:headless')) {
    return 'setup:headless';
  }
  if (cmd.endsWith('coverage:enforce')) {
    return 'coverage:enforce';
  }
  return cmd;
}

async function run(cmd) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    banner(`Starting ${cmd}`);
    const child = spawn(cmd, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => {
      const ms = Math.round(performance.now() - started);
      const label = stepLabel(cmd);
      if (code === 0) {
        console.log(`${GREEN}✔ ${label}${RESET} ${YELLOW}(${ms} ms)${RESET}`);
        resolve({ label, ms });
      } else {
        console.error(`${RED}✖ ${label} failed${RESET} ${YELLOW}(${ms} ms)${RESET}`);
        reject(Object.assign(new Error(`${label} failed`), { code, label, ms }));
      }
    });
  });
}

function buildPlan() {
  const plan = [];

  if (headless) {
    plan.push('pnpm -s run setup:headless');
  }
  if (!(noInstall || isFull)) {
    plan.push('pnpm -s install');
  }

  plan.push('pnpm -s run lint-all');
  plan.push('pnpm -s run build');
  plan.push('pnpm -s run type-check');

  // --fast: quick tests without coverage
  // default/--full: coverage tests + enforcement
  if (isFast) {
    plan.push('pnpm -s run test:fast');
  } else {
    plan.push('pnpm -s run test:coverage:split');
    if (!noCoverage) {
      plan.push('pnpm -s run coverage:enforce');
    }
  }

  plan.push('pnpm -s run test:browser');

  if (!noE2E) {
    plan.push('pnpm -s run test:e2e:functional');
    plan.push('pnpm -s run test:e2e:desktop');
  }

  return plan;
}

async function main() {
  const startedAll = performance.now();
  const steps = buildPlan();
  console.log(`${BOLD}Running ${steps.length} step(s):${RESET}`);
  for (const s of steps) {
    console.log(`  - ${s}`);
  }
  console.log('');

  const results = [];
  try {
    for (const cmd of steps) {
      const res = await run(cmd);
      results.push(res);
    }
  } catch (err) {
    const totalMs = Math.round(performance.now() - startedAll);
    console.log('');
    console.log(`${RED}${BOLD}Check failed${RESET} after ${YELLOW}${totalMs} ms${RESET}`);
    if (results.length) {
      console.log(`${BOLD}Completed steps:${RESET}`);
      for (const r of results) {
        console.log(`  - ${r.label} (${r.ms} ms)`);
      }
    }
    process.exit(typeof err.code === 'number' ? err.code : 1);
  }

  const totalMs = Math.round(performance.now() - startedAll);
  console.log('');
  console.log(`${GREEN}${BOLD}All checks passed${RESET} in ${YELLOW}${totalMs} ms${RESET}`);
  console.log(`${BOLD}Step timings:${RESET}`);
  for (const r of results) {
    console.log(`  - ${r.label} (${r.ms} ms)`);
  }
}

main();
