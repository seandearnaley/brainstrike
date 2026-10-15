import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import {
  APP_RENDERER_DOCUMENT_URL,
  APP_RENDERER_SCHEME,
  type DesktopRendererTarget,
  rendererIsolationHeaders,
} from './desktop-renderer-target';

export const APP_RENDERER_PROTOCOL_PRIVILEGE = {
  privileges: {
    bypassCSP: false,
    corsEnabled: true,
    secure: true,
    standard: true,
    stream: false,
    supportFetchAPI: true,
  },
  scheme: APP_RENDERER_SCHEME,
} as const;

const DOCUMENT_PATHNAME = new URL(APP_RENDERER_DOCUMENT_URL).pathname;

function confined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function bundledResourcePath(root: string, requestUrl: string): string | null {
  const document = new URL(APP_RENDERER_DOCUMENT_URL);
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== document.protocol ||
      url.host !== document.host ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes('\\') || decoded.includes('\0')) {
      return null;
    }
    const resource = path.resolve(root, `.${decoded}`);
    return confined(root, resource) ? resource : null;
  } catch {
    return null;
  }
}

/** Only bundled files; no network proxy or legacy file-origin route (BST-1999). */
export function createRendererProtocolHandler(
  rendererPath: string
): (request: Request) => Promise<Response> {
  const root = path.dirname(rendererPath);
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    const resource = bundledResourcePath(root, request.url);
    if (resource === null) {
      return new Response(null, { status: 404 });
    }
    try {
      const [actualRoot, actualResource] = await Promise.all([realpath(root), realpath(resource)]);
      if (!confined(actualRoot, actualResource)) {
        return new Response(null, { status: 404 });
      }
      const response = await net.fetch(pathToFileURL(actualResource).href, {
        method: request.method,
      });
      const headers = new Headers(response.headers);
      const isolation = rendererIsolationHeaders(new URL(request.url), [DOCUMENT_PATHNAME]);
      for (const [key, value] of Object.entries(isolation)) {
        headers.set(key, value);
      }
      return new Response(request.method === 'HEAD' ? null : response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }
  };
}

export function registerRendererProtocol(target: DesktopRendererTarget): void {
  if (target.kind === 'built-renderer') {
    protocol.handle(APP_RENDERER_SCHEME, createRendererProtocolHandler(target.rendererPath));
  }
}
