// @vitest-environment node
// Agent browsing's egress boundary in real Chromium (BST-1238). The fixture runs
// Main's actual pane host, agent partition routing, proxy credential answer and
// agent tools against a "public" site whose pages try to reach a loopback
// server by every route a page has: server redirects, client redirects,
// popups, and the partition itself. See fixtures/agent-browsing-electron.ts.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../../scripts/build-main-config.mjs';
import { createDisposableAppProfile } from '../helpers/disposable-app-profile';
import { electronExecutablePath, electronSessionEnvironment } from '../helpers/electron-executable';

const ReportSchema = z.object({ detail: z.unknown(), event: z.string() });
const BLOCKED =
  /^blocked_destination: agent browsing may not connect to (127\.0\.0\.1|localhost), a loopback address$/;

it('an agent tab reaches public pages through its proxy and never a loopback server', async () => {
  const desktop = resolve(import.meta.dirname, '../../..');
  await mkdir(join(desktop, 'dist'), { recursive: true });
  const directory = await mkdtemp(join(desktop, 'dist/agent-browsing-proof-'));
  const { root } = await createDisposableAppProfile('brainstrike-agent-browsing-');
  try {
    await build({
      ...MAIN_PROCESS_BUILD_OPTIONS,
      entryPoints: {
        'agent-egress-entry': 'src/agent-egress-entry.ts',
        driver: 'src/__tests__/fixtures/agent-browsing-electron.ts',
      },
      logLevel: 'silent',
      outdir: directory,
    });
    const result = await new Promise<{ code: unknown; stdout: string; stderr: string }>((done) => {
      execFile(
        electronExecutablePath(),
        [join(directory, 'driver.js'), `--user-data-dir=${root}`],
        {
          cwd: desktop,
          env: {
            ...electronSessionEnvironment(),
            BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
            BRAINSTRIKE_TEST_AGENT_EGRESS_ENTRY: join(directory, 'agent-egress-entry.js'),
            HOME: root,
            NODE_ENV: 'test',
            PATH: process.env['PATH'],
          },
          maxBuffer: 8 * 1024 * 1024,
          timeout: 90_000,
        },
        (error, stdout, stderr) => done({ code: error?.code, stderr, stdout })
      );
    });
    const reports = new Map(
      result.stdout.split('\n').flatMap((line) => {
        if (!line.startsWith('{')) {
          return [];
        }
        const parsed = ReportSchema.safeParse(JSON.parse(line));
        return parsed.success ? [[parsed.data.event, parsed.data.detail] as const] : [];
      })
    );
    expect(reports.get('failure'), result.stderr).toBeUndefined();
    expect(reports.has('done'), result.stderr).toBe(true);

    // The proxy carries a public page, answered with the per-launch credential.
    expect(reports.get('public')).toMatchObject({
      navigate: { ok: true, title: 'Public', url: 'http://public.test/ok' },
      text: expect.stringContaining('public page body'),
    });
    // A server redirect to loopback fails visibly and typed, plain http or https.
    for (const path of ['/redirect', '/redirect-https', '/redirect-localhost']) {
      const detail = reports.get(`server-redirect ${path}`) as {
        navigate: { error: string; hint: string };
        text: string;
      };
      expect(detail.navigate.error, path).toBe('blocked_destination');
      expect(`blocked_destination: ${detail.navigate.hint}`, path).toMatch(BLOCKED);
      expect(detail.text, path).not.toContain('SECRET-BST-1238');
    }
    // A client redirect fails after the first page settles; never its target.
    for (const path of ['/location', '/meta']) {
      const detail = reports.get(`client-redirect ${path}`) as { failure: string; text: string };
      expect(detail.failure, path).toMatch(BLOCKED);
      expect(detail.text, path).not.toContain('SECRET-BST-1238');
    }
    // A popup stays an agent tab, behind the same proxy.
    expect(reports.get('popup')).toMatchObject({ opened: 1, owner: 'agent' });
    expect((reports.get('popup') as { failure: string }).failure).toMatch(BLOCKED);
    // Chromium's implicit loopback bypass is removed: the partition itself
    // reaches loopback only through the proxy, which refuses it.
    expect((reports.get('direct literal') as { failure: string }).failure).toMatch(BLOCKED);
    expect((reports.get('direct localhost') as { failure: string }).failure).toMatch(BLOCKED);
    expect(reports.get('secret-hits-agent')).toBe(0);
    // The real utility entry refuses a literal loopback target and reports it.
    expect(reports.get('utility')).toEqual({
      refusal: {
        address: '127.0.0.1',
        addressClass: 'loopback',
        host: '127.0.0.1',
        reason: 'destination',
      },
      status: 'HTTP/1.1 403 Refused',
    });
    // Control: a user tab is unaffected and reaches the same server.
    expect(reports.get('user-tab')).toEqual({ error: null, owner: 'user', secretHits: 1 });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);
