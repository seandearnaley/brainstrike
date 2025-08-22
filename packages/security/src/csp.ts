/**
 * Content Security Policy utilities shared across Brainstrike apps
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

export type Environment = 'development' | 'production';

function getCSPDirectives(env: Environment): CSPDirectives {
  const isDev = env === 'development';

  return {
    'default-src': isDev ? ["'self'", 'http://localhost:*', 'ws://localhost:*'] : ["'self'"],

    // transformers.js relies on eval in both envs; allow blob: for WASM loader
    'script-src': isDev
      ? [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          'http://localhost:*',
          'https://cdn.jsdelivr.net',
          'blob:',
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

function directivesToString(directives: CSPDirectives): string {
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

export function getCSP(env: Environment): string {
  const directives = getCSPDirectives(env);
  return directivesToString(directives);
}

export function getDevCSP(): string {
  return getCSP('development');
}
