import { createPublicationInstrumentation } from '../committed-publication-instrumentation';

// This module must run before entry.ts dynamically imports React DOM.
export const { instrumentation, measurePublication, waitForQuiescence } =
  createPublicationInstrumentation('all-channels');
