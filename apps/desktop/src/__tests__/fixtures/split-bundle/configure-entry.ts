// Built as its own entry by node-process-bundle.test.ts, beside report-entry.ts.
import { addLogListener } from '@brainstrike/logging';
import { BrainStrikeError } from '@brainstrike/utils';

const messages: string[] = [];
addLogListener((record) => {
  if (record.message) {
    messages.push(record.message);
  }
});

Object.assign(globalThis, {
  splitBundleProof: { configuredErrorClass: BrainStrikeError, messages },
});
