import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CANVAS_FRAME_SHELL_PATH,
  getCanvasSandboxContentSecurityPolicy,
  renderCanvasFrameShellHtml,
} from '@brainstrike/platform-utils';
import { describe, expect, it, vi } from 'vitest';
import { canvasFrameShellPlugin, getCanvasFrameShellHeaders } from '../canvas-frame-plugin';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

function captureMiddleware(register: (server: unknown) => void): Middleware {
  let middleware: Middleware | null = null;
  register({
    middlewares: {
      use: (fn: Middleware) => {
        middleware = fn;
      },
    },
  });
  if (!middleware) {
    throw new Error('plugin registered no middleware');
  }
  return middleware;
}

function invoke(middleware: Middleware, url: string) {
  const headers = new Map<string, string>();
  let body: string | null = null;
  const res = {
    end: (chunk: string) => {
      body = chunk;
    },
    setHeader: (key: string, value: string) => {
      headers.set(key, value);
    },
    statusCode: 0,
  } as unknown as ServerResponse;
  const next = vi.fn();
  middleware({ url } as IncomingMessage, res, next);
  return { body, headers, next, res };
}

describe('canvasFrameShellPlugin', () => {
  const plugin = canvasFrameShellPlugin();

  it('serves the shell with the full sandbox header set in dev and preview', () => {
    for (const register of [plugin.configureServer, plugin.configurePreviewServer]) {
      const middleware = captureMiddleware(register as (server: unknown) => void);
      const { body, headers, next, res } = invoke(middleware, CANVAS_FRAME_SHELL_PATH);
      expect(next).not.toHaveBeenCalled();
      expect((res as { statusCode: number }).statusCode).toBe(200);
      expect(body).toBe(renderCanvasFrameShellHtml());
      for (const [key, value] of Object.entries(getCanvasFrameShellHeaders())) {
        expect(headers.get(key)).toBe(value);
      }
      expect(headers.get('Content-Security-Policy')).toBe(getCanvasSandboxContentSecurityPolicy());
      expect(headers.has('X-Frame-Options')).toBe(false);
    }
  });

  it('passes every other request through untouched', () => {
    const middleware = captureMiddleware(plugin.configureServer as (server: unknown) => void);
    for (const url of ['/', '/index.html', `${CANVAS_FRAME_SHELL_PATH}/nested`, undefined]) {
      const { next } = invoke(middleware, url as string);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('emits the shell into the production bundle at the served path', () => {
    const emitFile = vi.fn();
    (plugin.generateBundle as unknown as (this: { emitFile: typeof emitFile }) => void).call({
      emitFile,
    });
    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'canvas-frame.html',
      source: renderCanvasFrameShellHtml(),
      type: 'asset',
    });
  });
});
