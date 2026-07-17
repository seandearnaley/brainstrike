/**
 * Content Security Policy utility for consistent CSP across dev server and Electron
 */

interface CSPDirectives {
  'base-uri': string[];
  'connect-src': string[];
  'default-src': string[];
  'font-src': string[];
  'form-action': string[];
  'frame-ancestors': string[];
  'img-src': string[];
  'object-src': string[];
  'script-src': string[];
  'style-src': string[];
  'worker-src': string[];
}

type Environment = 'development' | 'production';

/**
 * Get CSP directives based on environment.
 *
 * Configures security policies for:
 * - Local development (allows localhost, HMR websockets)
 * - Production (strict defaults, no unsafe-inline)
 * - Embedding providers (whitelists external APIs like OpenAI, Google)
 * - Worker isolation (allows blob workers)
 *
 * @param env - 'development' or 'production'
 * @returns Object mapping CSP directives to allowed sources
 */
function getCSPDirectives(env: Environment): CSPDirectives {
  const isDev = env === 'development';

  return {
    'base-uri': ["'self'"],

    'connect-src': isDev
      ? [
          "'self'",
          'ws://localhost:*',
          'http://localhost:*',
          'http://127.0.0.1:*',
          'ws://127.0.0.1:*',
          'wss://localhost:*',
          'https://huggingface.co',
          'https://*.hf.co',
          'https://cdn.jsdelivr.net',
          'https://api.openai.com',
          'https://generativelanguage.googleapis.com',
          'https://api.cohere.com',
          'https://api.voyageai.com',
        ]
      : [
          "'self'",
          'http://127.0.0.1:*',
          'http://localhost:*',
          'https://huggingface.co',
          'https://*.hf.co',
          'https://cdn.jsdelivr.net',
          'https://api.openai.com',
          'https://generativelanguage.googleapis.com',
          'https://api.cohere.com',
          'https://api.voyageai.com',
        ],
    'default-src': isDev ? ["'self'", 'http://localhost:*', 'ws://localhost:*'] : ["'self'"],

    'font-src': isDev ? ["'self'", 'data:', 'http://localhost:*'] : ["'self'", 'data:'],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],

    // `brainstrike-asset:` serves root-validated local images (markdown viewer);
    // the custom protocol enforces workspace-root containment, CSP scopes usage.
    'img-src': isDev
      ? ["'self'", 'data:', 'blob:', 'brainstrike-asset:', 'http://localhost:*']
      : ["'self'", 'data:', 'blob:', 'brainstrike-asset:'],

    'object-src': ["'none'"],

    'script-src': isDev
      ? [
          "'self'",
          'blob:',
          "'unsafe-inline'",
          "'unsafe-eval'",
          'http://localhost:*',
          'https://cdn.jsdelivr.net',
        ]
      : ["'self'", 'blob:', "'unsafe-eval'", 'https://cdn.jsdelivr.net'],

    'style-src': isDev
      ? ["'self'", "'unsafe-inline'", 'http://localhost:*']
      : ["'self'", "'unsafe-inline'"],

    'worker-src': ["'self'", 'blob:'],
  };
}

/**
 * Convert CSP directives object to CSP string.
 * Joins values with spaces and directives with semicolons.
 *
 * @param directives - Map of directive names to array of allowed sources
 * @returns Formatted Content-Security-Policy header string
 */
function directivesToString(directives: CSPDirectives): string {
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

/**
 * Get Content Security Policy string for the given environment.
 * Primary entry point for configuring Electron session and Vite dev server.
 *
 * @param env - Target environment ('development' | 'production')
 * @returns Full CSP header string
 */
export function getCSP(env: Environment): string {
  const directives = getCSPDirectives(env);
  return directivesToString(directives);
}

/**
 * Get development-mode Content Security Policy.
 * Helper for Vite config where environment is implicitly development.
 *
 * @returns Development CSP string
 */
export function getDevCSP(): string {
  return getCSP('development');
}
