import { describe, expect, it } from 'vitest';
import {
  parseMcpAppMimeType,
  parseMcpAppResourceMeta,
  parseMcpAppResourceUri,
  parseMcpAppToolMeta,
} from '../src/index.js';

describe('stable MCP Apps resource identity', () => {
  it('accepts only ui:// resources with the exact stable MIME type', () => {
    expect(parseMcpAppResourceUri('ui://weather/dashboard')).toBe('ui://weather/dashboard');
    expect(parseMcpAppResourceUri('ui:///weather/dashboard')).toBe('ui:///weather/dashboard');
    expect(parseMcpAppMimeType('text/html;profile=mcp-app')).toBe('text/html;profile=mcp-app');
  });

  it.each(['https://example.com/app', 'ui:weather', 'ui://', '', 42])(
    'rejects a non-App resource URI: %j',
    (input) => {
      expect(() => parseMcpAppResourceUri(input)).toThrow(/MCP Apps resource URI/);
    }
  );

  it('rejects oversized resource identifiers and metadata collections', () => {
    expect(() => parseMcpAppResourceUri(`ui://app/${'x'.repeat(2049)}`)).toThrow(/length/);
    expect(() =>
      parseMcpAppResourceMeta({ csp: { connectDomains: new Array(33).fill('https://a.test') } })
    ).toThrow(/at most 32/);
    expect(() => parseMcpAppToolMeta({ visibility: new Array(33).fill('app') })).toThrow(
      /at most 32/
    );
  });

  it.each([
    'https://cdn.example.com; script-src-elem https://evil.example',
    'https://cdn.example.com;script-src-elem',
    'https://cdn.example.com,https://evil.example',
    "https://cdn.example.com'",
    'https://cdn.example.com\t',
  ])('rejects a CSP source that could split or extend a directive: %j', (domain) => {
    expect(() => parseMcpAppResourceMeta({ csp: { resourceDomains: [domain] } })).toThrow(
      /CSP (delimiters|origin)/
    );
  });

  it.each(['text/html', 'text/html; profile=mcp-app', 'text/html;profile=MCP-app', '', null])(
    'rejects a noncanonical App MIME type: %j',
    (input) => {
      expect(() => parseMcpAppMimeType(input)).toThrow(/MCP Apps resource MIME type/);
    }
  );
});

describe('stable MCP Apps resource metadata', () => {
  it('accepts the complete stable metadata vocabulary', () => {
    expect(
      parseMcpAppResourceMeta({
        csp: {
          baseUriDomains: ['https://cdn.example.com'],
          connectDomains: ['https://api.example.com', 'wss://realtime.example.com'],
          frameDomains: ['https://player.example.com'],
          resourceDomains: ['https://cdn.example.com', 'https://*.cloudflare.com'],
        },
        domain: 'apps.example.com',
        permissions: {
          camera: {},
          clipboardWrite: {},
          geolocation: {},
          microphone: {},
        },
        prefersBorder: true,
      })
    ).toEqual({
      csp: {
        baseUriDomains: ['https://cdn.example.com'],
        connectDomains: ['https://api.example.com', 'wss://realtime.example.com'],
        frameDomains: ['https://player.example.com'],
        resourceDomains: ['https://cdn.example.com', 'https://*.cloudflare.com'],
      },
      domain: 'apps.example.com',
      permissions: {
        camera: {},
        clipboardWrite: {},
        geolocation: {},
        microphone: {},
      },
      prefersBorder: true,
    });
  });

  it.each([
    { draftField: true },
    { csp: { scriptDomains: ['https://example.com'] } },
    { csp: { connectDomains: 'https://example.com' } },
    { csp: { connectDomains: ['*'] } },
    { csp: { frameDomains: ["'unsafe-inline'"] } },
    { csp: { resourceDomains: ['data:'] } },
    { csp: { resourceDomains: ['https://example.com/path'] } },
    { permissions: { camera: { reason: 'needed' } } },
    { permissions: { notifications: {} } },
    { domain: 42 },
    { domain: '' },
    { domain: 'javascript:alert(1)' },
    { domain: 'apps.example.com/../evil' },
    { domain: 'https://apps.example.com:8080/path' },
    { prefersBorder: 'yes' },
  ])('rejects malformed or extra resource metadata: %j', (input) => {
    expect(() => parseMcpAppResourceMeta(input)).toThrow(/MCP Apps resource metadata/);
  });
});

describe('stable MCP Apps tool metadata', () => {
  it('accepts the nested stable tool metadata vocabulary', () => {
    expect(
      parseMcpAppToolMeta({
        resourceUri: 'ui://weather/dashboard',
        visibility: ['model', 'app'],
      })
    ).toEqual({
      resourceUri: 'ui://weather/dashboard',
      visibility: ['model', 'app'],
    });
  });

  it('preserves canonical empty and duplicate visibility declarations', () => {
    expect(parseMcpAppToolMeta({ visibility: [] })).toEqual({ visibility: [] });
    expect(parseMcpAppToolMeta({ visibility: ['app', 'app'] })).toEqual({
      visibility: ['app', 'app'],
    });
  });

  it.each([
    { resourceUri: 'https://example.com/app' },
    { visibility: ['server'] },
    { visibility: 'app' },
    { csp: {}, resourceUri: 'ui://weather/dashboard' },
    { permissions: {}, resourceUri: 'ui://weather/dashboard' },
    { resourceUri: 'ui://weather/dashboard', widgetAccessible: true },
  ])('rejects malformed or extra tool metadata: %j', (input) => {
    expect(() => parseMcpAppToolMeta(input)).toThrow(/MCP Apps tool metadata/);
  });
});
