/**
 * Hermetic unit coverage for the webExtract tool (report R5): Tavily's
 * /extract endpoint behind the SAME keyless-honest / non-fatal-error /
 * exact-recovery contract as webSearch (see web-search-tool.test.ts, whose
 * injected-deps pattern this mirrors — no real network or keychain).
 *
 * Plus the URL guard, which webSearch does not need: model-supplied URLs are
 * validated BEFORE anything is sent to the external service — http/https
 * only, no embedded credentials, and no private/loopback/link-local hosts
 * (an internal URL must never leak to Tavily, and per-URL refusals surface
 * honestly in the result, never silently dropped).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runWebExtract,
  type WebExtractToolDependencies,
} from '../src/native-tools/web-extract-tool.js';

function okJsonResponse(body: unknown): Response {
  return {
    json: () => Promise.resolve(body),
    ok: true,
    status: 200,
  } as unknown as Response;
}

function tavilyExtractBody(
  results: Array<{ url: string; raw_content: string }>,
  failed: Array<{ url: string; error?: string }> = []
): unknown {
  // biome-ignore-start lint/style/useNamingConvention: Tavily API wire fields
  return { failed_results: failed, results };
  // biome-ignore-end lint/style/useNamingConvention: Tavily API wire fields
}

function deps(overrides: Partial<WebExtractToolDependencies> = {}): WebExtractToolDependencies {
  return {
    fetchImpl: vi.fn().mockResolvedValue(okJsonResponse(tavilyExtractBody([]))),
    resolveApiKey: vi.fn().mockResolvedValue('tvly-test-key'),
    ...overrides,
  };
}

describe('web-extract-tool', () => {
  it('returns a non-fatal unavailable result when no Tavily key is configured', async () => {
    const fetchImpl = vi.fn();
    const result = await runWebExtract(
      { urls: ['https://example.com/docs'] },
      deps({ fetchImpl, resolveApiKey: vi.fn().mockResolvedValue(undefined) })
    );

    expect(result.available).toBe(false);
    expect(result.message).toMatch(/tavily api key/i);
    expect(result.results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('extracts pages and returns byte-exact markdown content', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okJsonResponse(
          tavilyExtractBody([
            { raw_content: '# Docs\n\nSome markdown content.', url: 'https://example.com/docs' },
          ])
        )
      );
    const result = await runWebExtract({ urls: ['https://example.com/docs'] }, deps({ fetchImpl }));

    expect(result.available).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      content: '# Docs\n\nSome markdown content.',
      url: 'https://example.com/docs',
    });
    // Key sent as Bearer auth, never in the result.
    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>)['authorization']).toBe(
      'Bearer tvly-test-key'
    );
    expect(JSON.stringify(result)).not.toContain('tvly-test-key');
  });

  it('refuses non-http(s), credentialed, and private/loopback URLs BEFORE any network call', async () => {
    const fetchImpl = vi.fn();
    const result = await runWebExtract(
      {
        urls: [
          'file:///etc/passwd',
          'https://user:pass@example.com/a',
          'http://127.0.0.1:8080/admin',
          'http://localhost/internal',
          'http://10.0.0.5/metadata',
          'http://192.168.1.1/router',
          'http://169.254.169.254/latest/meta-data',
          'http://[::1]/loopback',
          'not a url',
        ],
      },
      deps({ fetchImpl })
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
    // Every refused URL is reported honestly, never silently dropped.
    expect(result.failed).toHaveLength(9);
    for (const failure of result.failed) {
      expect(failure.reason).toMatch(/refused|invalid/i);
    }
  });

  it('refuses obfuscated internal hosts: IPv4-mapped/compat IPv6 and trailing-dot localhost', async () => {
    // WHATWG URL serializes IPv4-mapped/compat IPv6 to HEX hextets
    // (::ffff:127.0.0.1 -> ::ffff:7f00:1, ::127.0.0.1 -> ::7f00:1) and keeps
    // a root-label trailing dot on hostnames — all three previously slipped
    // past the guard (review finding).
    const fetchImpl = vi.fn();
    const result = await runWebExtract(
      {
        urls: [
          'http://[::ffff:127.0.0.1]/loopback-mapped',
          'http://[::ffff:169.254.169.254]/metadata-mapped',
          'http://[::ffff:c0a8:101]/rfc1918-mapped-hex',
          'http://[::127.0.0.1]/loopback-compat',
          'http://localhost./trailing-dot',
          'http://sub.localhost./trailing-dot-sub',
        ],
      },
      deps({ fetchImpl })
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.failed).toHaveLength(6);
    for (const failure of result.failed) {
      expect(failure.reason).toMatch(/refused/i);
    }
  });

  it('preserves exact failure reasons and URL identity for durable recovery', async () => {
    const longPath = 'a'.repeat(1900);
    const hugeReason = 'upstream exploded: '.repeat(600);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okJsonResponse(
          tavilyExtractBody([], [{ error: hugeReason, url: `https://example.com/${longPath}` }])
        )
      );
    const result = await runWebExtract(
      {
        urls: [
          `https://example.com/${longPath}`,
          `http://10.0.0.1/${longPath}`,
          `http://10.0.0.2/${longPath}`,
          `http://10.0.0.3/${longPath}`,
          `http://10.0.0.4/${longPath}`,
        ],
      },
      deps({ fetchImpl })
    );

    // 1 Tavily-side failure + 4 local refusals, with no lossy producer clipping.
    expect(result.failed).toHaveLength(5);
    expect(result.failed).toContainEqual({
      reason: hugeReason,
      url: `https://example.com/${longPath}`,
    });
    expect(result.failed).toContainEqual({
      reason: 'refused: private/loopback/link-local hosts are never sent to the extraction service',
      url: `http://10.0.0.1/${longPath}`,
    });
  });

  it('preserves fully-refused URL identity with no network use', async () => {
    const fetchImpl = vi.fn();
    const longPath = 'b'.repeat(1900);
    const result = await runWebExtract(
      {
        urls: Array.from({ length: 5 }, (_, index) => `http://192.168.0.${index}/${longPath}`),
      },
      deps({ fetchImpl })
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(5);
    expect(result.failed.map((failure) => failure.url)).toEqual(
      Array.from({ length: 5 }, (_, index) => `http://192.168.0.${index}/${longPath}`)
    );
  });

  it('extracts valid URLs while reporting refused ones alongside', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okJsonResponse(
          tavilyExtractBody([{ raw_content: 'public content', url: 'https://example.com/ok' }])
        )
      );
    const result = await runWebExtract(
      { urls: ['https://example.com/ok', 'http://192.168.0.10/private'] },
      deps({ fetchImpl })
    );

    expect(result.results).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.url).toBe('http://192.168.0.10/private');
    // Only the valid URL was sent to Tavily.
    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string).urls).toEqual(['https://example.com/ok']);
  });

  it('reports Tavily-side extraction failures honestly', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okJsonResponse(
          tavilyExtractBody([], [{ error: 'page not reachable', url: 'https://example.com/gone' }])
        )
      );
    const result = await runWebExtract({ urls: ['https://example.com/gone'] }, deps({ fetchImpl }));

    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain('page not reachable');
  });

  it('returns a non-fatal error result on a non-OK Tavily response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ json: () => Promise.resolve({}), ok: false, status: 401 } as Response);
    const result = await runWebExtract({ urls: ['https://example.com/docs'] }, deps({ fetchImpl }));

    expect(result.available).toBe(true);
    expect(result.error).toContain('401');
    expect(result.results).toEqual([]);
  });

  it('returns a non-fatal timeout result when the request aborts', async () => {
    const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn().mockRejectedValue(timeoutError);
    const result = await runWebExtract(
      { urls: ['https://example.com/docs'] },
      deps({ fetchImpl, timeoutMs: 5 })
    );

    expect(result.available).toBe(true);
    expect(result.error).toMatch(/timed out/i);
  });

  it('preserves oversized Unicode and escaped source content for central artifact settlement', async () => {
    const hugeContent = `${'雪\\n"quoted" 😀'.repeat(6000)}\nTAIL-IS-EXACT`;
    const fetchImpl = vi.fn().mockResolvedValue(
      okJsonResponse(
        tavilyExtractBody([
          { raw_content: hugeContent, url: 'https://example.com/big-1' },
          { raw_content: hugeContent, url: 'https://example.com/big-2' },
        ])
      )
    );
    const result = await runWebExtract(
      { urls: ['https://example.com/big-1', 'https://example.com/big-2'] },
      deps({ fetchImpl })
    );

    expect(result.results).toEqual([
      { content: hugeContent, url: 'https://example.com/big-1' },
      { content: hugeContent, url: 'https://example.com/big-2' },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
