import { app, session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCSP } from '../csp-utils';
import { desktopSecurityLogger, setupSecurity } from '../setup-security';

vi.mock('@brainstrike/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: vi.fn(),
      },
    },
  },
}));

vi.mock('../csp-utils', () => ({
  getCSP: vi.fn(),
}));

describe('setupSecurity', () => {
  const mockLoggerInfo = vi.spyOn(desktopSecurityLogger, 'info').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockLoggerInfo.mockClear();
  });

  it('should configure CSP for development mode', () => {
    const mockCSP = 'dev-csp-policy';
    vi.mocked(getCSP).mockReturnValue(mockCSP);
    Object.defineProperty(vi.mocked(app), 'isPackaged', { configurable: true, value: false });

    setupSecurity();

    expect(getCSP).toHaveBeenCalledWith('development');
    expect(session.defaultSession.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'CSP configured',
      expect.objectContaining({ mode: 'Development', policy: mockCSP })
    );
  });

  it('should configure CSP for production mode', () => {
    const mockCSP = 'prod-csp-policy';
    vi.mocked(getCSP).mockReturnValue(mockCSP);
    Object.defineProperty(vi.mocked(app), 'isPackaged', { configurable: true, value: true });

    setupSecurity();

    expect(getCSP).toHaveBeenCalledWith('production');
    expect(session.defaultSession.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'CSP configured',
      expect.objectContaining({ mode: 'Production', policy: mockCSP })
    );
  });

  it('should set CSP headers in response', () => {
    const mockCSP = 'test-csp-policy';
    vi.mocked(getCSP).mockReturnValue(mockCSP);

    setupSecurity();

    const onHeadersReceived = vi.mocked(session.defaultSession.webRequest.onHeadersReceived);
    const handler = onHeadersReceived.mock.calls[0]?.[0];

    const details = {
      id: 1,
      method: 'GET',
      referrer: '',
      resourceType: 'mainFrame',
      responseHeaders: {
        'X-Frame-Options': ['DENY'],
      },
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      timestamp: Date.now(),
      url: 'http://localhost:3000',
    } as any;

    const callback = vi.fn();
    handler?.(details, callback);

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': [mockCSP],
        'Permissions-Policy': ['camera=(), microphone=(), geolocation=(), payment=()'],
        'Referrer-Policy': ['strict-origin-when-cross-origin'],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY'],
        'X-XSS-Protection': ['0'],
      },
    });
  });

  it('exempts brainstrike-canvas: responses — the protocol handler owns their headers (BST-1173)', () => {
    // Stamping here would (a) re-impose X-Frame-Options: DENY, making the
    // Canvas shell unframeable, and (b) attach the app CSP to the shell, which
    // the inner srcdoc would INHERIT — silently breaking inline canvas scripts
    // in production only. The canvas-protocol handler already serves the
    // reviewed sandbox CSP on every response, so pass its headers through.
    vi.mocked(getCSP).mockReturnValue('app-csp-policy');

    setupSecurity();

    const onHeadersReceived = vi.mocked(session.defaultSession.webRequest.onHeadersReceived);
    const handler = onHeadersReceived.mock.calls[0]?.[0];

    const details = {
      id: 1,
      method: 'GET',
      referrer: '',
      resourceType: 'subFrame',
      responseHeaders: {
        'Content-Security-Policy': ['canvas-sandbox-policy'],
        'Content-Type': ['text/html; charset=utf-8'],
      },
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      timestamp: Date.now(),
      url: 'brainstrike-canvas://shell/',
    } as any;
    const callback = vi.fn();

    handler?.(details, callback);

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': ['canvas-sandbox-policy'],
        'Content-Type': ['text/html; charset=utf-8'],
      },
    });
  });

  it('should handle missing responseHeaders', () => {
    const mockCSP = 'test-csp-policy';
    vi.mocked(getCSP).mockReturnValue(mockCSP);

    setupSecurity();

    const onHeadersReceived = vi.mocked(session.defaultSession.webRequest.onHeadersReceived);
    const handler = onHeadersReceived.mock.calls[0]?.[0];

    const details = {
      id: 1,
      method: 'GET',
      referrer: '',
      resourceType: 'mainFrame',
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      timestamp: Date.now(),
      url: 'http://localhost:3000',
    } as any;
    const callback = vi.fn();

    handler?.(details, callback);

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': [mockCSP],
        'Permissions-Policy': ['camera=(), microphone=(), geolocation=(), payment=()'],
        'Referrer-Policy': ['strict-origin-when-cross-origin'],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY'],
        'X-XSS-Protection': ['0'],
      },
    });
  });
});
