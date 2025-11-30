import { app, session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCSP } from '../csp-utils';
import { desktopSecurityLogger, setupSecurity } from '../setup-security';

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
    Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

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
    Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });

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
      url: 'http://localhost:3000',
      method: 'GET',
      resourceType: 'mainFrame',
      referrer: '',
      timestamp: Date.now(),
      statusLine: 'HTTP/1.1 200 OK',
      statusCode: 200,
      responseHeaders: {
        'X-Frame-Options': ['DENY'],
      },
    } as any;

    const callback = vi.fn();
    handler?.(details, callback);

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'X-Frame-Options': ['DENY'],
        'Content-Security-Policy': [mockCSP],
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
      url: 'http://localhost:3000',
      method: 'GET',
      resourceType: 'mainFrame',
      referrer: '',
      timestamp: Date.now(),
      statusLine: 'HTTP/1.1 200 OK',
      statusCode: 200,
    } as any;
    const callback = vi.fn();

    handler?.(details, callback);

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': [mockCSP],
      },
    });
  });
});
