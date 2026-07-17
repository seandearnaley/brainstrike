import { app, session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCSP } from '../csp-utils';
import { desktopSecurityLogger, setupSecurity } from '../setup-security';

vi.mock('@brainstrike/utils/logger', () => ({
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
