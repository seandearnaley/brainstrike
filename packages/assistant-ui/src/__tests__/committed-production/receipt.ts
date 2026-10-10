import type { run } from './measure';

export type ProductionMeasurement = Awaited<ReturnType<typeof run>>;

declare global {
  interface Window {
    committedProductionError?: string;
    committedProductionMeasurement?: ProductionMeasurement;
  }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    measureCommittedProduction: (options: { timeout: number }) => Promise<ProductionMeasurement>;
  }
}
