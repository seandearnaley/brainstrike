import { z } from 'zod';

// Separate configuration from the application's bundled schema graph. Keeping
// both graphs static previously co-located schema initialization ahead of config.
z.config({ jitless: true });
await import('./configure-browser-runtime');
await import('./main');
