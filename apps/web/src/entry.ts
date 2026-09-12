import { z } from 'zod';

// Complete CSP configuration before importing modules that construct schemas.
// A static side-effect import cannot precede its sibling dependency evaluation.
z.config({ jitless: true });
await import('./main');
