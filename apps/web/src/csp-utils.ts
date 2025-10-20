/**
 * Content Security Policy utility for consistent CSP across dev server and Electron
 *
 * This file is used to generate the CSP for the web application.
 */

interface CSPDirectives {
  'default-src': string[];
  'script-src': string[];
  'worker-src': string[];
  'style-src': string[];
  'img-src': string[];
  'font-src': string[];
  'connect-src': string[];
  'object-src': string[];
  'base-uri': string[];
  'form-action': string[];
  'frame-ancestors': string[];
}

type Environment = 'development' | 'production';

/**
 * Get CSP directives based on environment
 */
function getCSPDirectives(env: Environment): CSPDirectives {
  const isDev = env === 'development';

  return {
    'default-src': isDev ? ["'self'", 'http://localhost:*', 'ws://localhost:*'] : ["'self'"],

    'script-src': isDev
      ? [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          'http://localhost:*',
          'https://cdn.jsdelivr.net',
          'blob:', // Allow blob URLs for ONNX.js WASM loading
        ]
      : ["'self'", "'unsafe-eval'", 'https://cdn.jsdelivr.net', 'blob:'],

    'worker-src': ["'self'", 'blob:'],

    'style-src': isDev
      ? ["'self'", "'unsafe-inline'", 'http://localhost:*']
      : ["'self'", "'unsafe-inline'"],

    'img-src': isDev
      ? ["'self'", 'data:', 'blob:', 'http://localhost:*']
      : ["'self'", 'data:', 'blob:'],

    'font-src': isDev ? ["'self'", 'data:', 'http://localhost:*'] : ["'self'", 'data:'],

    'connect-src': isDev
      ? [
          "'self'",
          'ws://localhost:*',
          'http://localhost:*',
          'ws://127.0.0.1:*',
          'wss://localhost:*',
          'https://huggingface.co',
          'https://*.hf.co',
          'https://cdn.jsdelivr.net',
        ]
      : ["'self'", 'https://huggingface.co', 'https://*.hf.co', 'https://cdn.jsdelivr.net'],

    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
}

/**
 * Convert CSP directives object to CSP string
 */
function directivesToString(directives: CSPDirectives): string {
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

/**
 * Get CSP string for the given environment
 */
export function getCSP(env: Environment): string {
  const directives = getCSPDirectives(env);
  return directivesToString(directives);
}

/**
 * Get development CSP string
 */
export function getDevCSP(): string {
  return getCSP('development');
}
