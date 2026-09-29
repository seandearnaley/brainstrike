import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface MainSourceSections {
  /** `planDesktopShutdownRun`, which builds one shutdown run's step bodies. */
  readonly shutdownPlanBlock: string;
  readonly source: string;
  /**
   * One step's body inside the plan. The step record's keys are sorted, not
   * ordered (the order is `DESKTOP_SHUTDOWN_STEP_ORDER`), so a body ends at
   * the next key at the same indentation, without that key's leading comment.
   */
  readonly stepBody: (step: string) => string;
}

const STEP_KEY = /\n {6}(?:'[a-z-]+'|[a-z]+): /g;

/** Reads `main.ts` and slices out the shutdown plan for source-text wiring tests. */
export function readMainSourceSections(): MainSourceSections {
  const source = readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');
  const planStart = source.indexOf('function planDesktopShutdownRun');
  if (planStart < 0) {
    throw new Error('Expected main.ts to define planDesktopShutdownRun');
  }
  const planEnd = source.indexOf(
    'const gracefulShutdown = createDesktopGracefulShutdown',
    planStart
  );
  if (planEnd <= planStart) {
    throw new Error('Expected createDesktopGracefulShutdown to follow the shutdown plan');
  }
  const shutdownPlanBlock = source.slice(planStart, planEnd);
  const stepBody = (step: string): string => {
    const key = /^[a-z]+$/.test(step) ? `${step}: ` : `'${step}': `;
    const start = shutdownPlanBlock.indexOf(`\n      ${key}`);
    if (start < 0) {
      throw new Error(`Expected a '${step}' step body in planDesktopShutdownRun`);
    }
    STEP_KEY.lastIndex = start + 1;
    const next = STEP_KEY.exec(shutdownPlanBlock);
    const lines = shutdownPlanBlock
      .slice(start, next ? next.index : shutdownPlanBlock.length)
      .split('\n');
    // Drop the NEXT step's leading comment, which sits above its key.
    while (lines.length > 1 && /^\s*(?:\/\/.*)?$/.test(lines.at(-1) ?? '')) {
      lines.pop();
    }
    return lines.join('\n');
  };
  return { shutdownPlanBlock, source, stepBody };
}
