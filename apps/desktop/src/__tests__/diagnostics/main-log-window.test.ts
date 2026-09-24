import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertMainLogWindowRequest,
  MAIN_LOG_WINDOW_LIMITS,
  readMainLogWindow,
} from '../../diagnostics/main-log-window';

function line(
  time: string,
  level: number,
  msg: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({ level, time, ...extra, msg });
}

const createdDirs: string[] = [];
function logDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'main-log-window-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('readMainLogWindow', () => {
  it('returns warn+ lines inside the window, counts markers over every level, and reads rotated siblings', async () => {
    const logFilePath = path.join(logDir(), 'brainstrike.log');
    writeFileSync(
      `${logFilePath}.1`,
      `${[
        line('2026-09-15T02:18:00.000Z', 50, 'before window'),
        line('2026-09-15T02:19:05.000Z', 50, 'Unhandled promise rejection', { reason: 'x' }),
        line('2026-09-15T02:19:06.000Z', 30, 'info Cannot allocate Wasm memory for new instance'),
      ].join('\n')}\n`
    );
    writeFileSync(
      logFilePath,
      `${[
        line('2026-09-15T02:20:00.000Z', 40, 'Tool execution timed out', { toolName: 'grep' }),
        line('2026-09-15T02:20:01.000Z', 40, 'Subagent delegation returned no answer', {
          code: 'subagent_delegation_empty_result',
        }),
        '{"level":50,"time":"2026-09-15T02:20:02.000Z","msg":"trunc',
        line('2026-09-15T02:30:00.000Z', 50, 'after window'),
      ].join('\n')}\n`
    );
    const result = await readMainLogWindow({
      logFilePath,
      request: { since: '2026-09-15T02:19:00.000Z', until: '2026-09-15T02:25:00.000Z' },
    });
    expect(result.lines.map((raw) => JSON.parse(raw).msg)).toEqual([
      'Unhandled promise rejection',
      'Tool execution timed out',
      'Subagent delegation returned no answer',
    ]);
    expect(result.counts).toEqual({
      emptyChildResults: 1,
      toolTimeouts: 1,
      unhandledRejections: 1,
      wasmAllocationFailures: 1,
    });
    expect(result.scannedLineCount).toBe(4);
    expect(result.malformedLineCount).toBe(1);
    expect(result.files.map((file) => file.name)).toEqual(['brainstrike.log.1', 'brainstrike.log']);
    expect(result.files[0]).toEqual({
      firstTime: '2026-09-15T02:18:00.000Z',
      lastTime: '2026-09-15T02:19:06.000Z',
      name: 'brainstrike.log.1',
    });
    expect(result.droppedLineCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.since).toBe('2026-09-15T02:19:00.000Z');
    expect(result.until).toBe('2026-09-15T02:25:00.000Z');
  });

  it('caps the returned lines by count and bytes, keeping the NEWEST and reporting the drop', async () => {
    const logFilePath = path.join(logDir(), 'brainstrike.log');
    const lines: string[] = [];
    for (let index = 0; index < MAIN_LOG_WINDOW_LIMITS.maxLines + 10; index += 1) {
      const minutes = String(Math.floor(index / 60)).padStart(2, '0');
      const seconds = String(index % 60).padStart(2, '0');
      lines.push(line(`2026-09-15T02:${minutes}:${seconds}.000Z`, 40, `w${index}`));
    }
    writeFileSync(logFilePath, `${lines.join('\n')}\n`);
    const result = await readMainLogWindow({
      logFilePath,
      request: { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T03:00:00.000Z' },
    });
    expect(result.lines).toHaveLength(MAIN_LOG_WINDOW_LIMITS.maxLines);
    expect(JSON.parse(result.lines[0] as string).msg).toBe('w10');
    expect(JSON.parse(result.lines.at(-1) as string).msg).toBe(
      `w${MAIN_LOG_WINDOW_LIMITS.maxLines + 9}`
    );
    expect(result.droppedLineCount).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('caps the returned bytes as well as the line count', async () => {
    const logFilePath = path.join(logDir(), 'brainstrike.log');
    const bulk = 'y'.repeat(600 * 1024);
    writeFileSync(
      logFilePath,
      `${[
        line('2026-09-15T02:00:01.000Z', 40, `a ${bulk}`),
        line('2026-09-15T02:00:02.000Z', 40, `b ${bulk}`),
        line('2026-09-15T02:00:03.000Z', 40, `c ${bulk}`),
        line('2026-09-15T02:00:04.000Z', 40, `d ${bulk}`),
      ].join('\n')}\n`
    );
    const result = await readMainLogWindow({
      logFilePath,
      request: { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T02:10:00.000Z' },
    });
    expect(result.lines.map((raw) => (JSON.parse(raw).msg as string).slice(0, 1))).toEqual([
      'b',
      'c',
      'd',
    ]);
    expect(result.droppedLineCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('rejects a missing live log file instead of reporting an empty window', async () => {
    const logFilePath = path.join(logDir(), 'brainstrike.log');
    await expect(
      readMainLogWindow({
        logFilePath,
        request: { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T02:10:00.000Z' },
      })
    ).rejects.toThrow('brainstrike.log');
  });

  it('rejects a parseable record with no time field, but still counts a crash-truncated line', async () => {
    const window = { since: '2026-09-15T02:19:00.000Z', until: '2026-09-15T02:25:00.000Z' };
    // Each case needs its own LIVE log, which `candidateFiles` resolves by
    // exact path and so must be named `brainstrike.log`. `logDir()` returns a
    // FRESH temp directory per call, so these are one live log apiece in two
    // separate directories, not two files side by side in one.
    const truncatedCaseLiveLog = path.join(logDir(), 'brainstrike.log');
    writeFileSync(
      truncatedCaseLiveLog,
      `${[line('2026-09-15T02:20:00.000Z', 50, 'timestamped'), '{"level":5'].join('\n')}\n`
    );
    const truncated = await readMainLogWindow({
      logFilePath: truncatedCaseLiveLog,
      request: window,
    });
    expect(truncated.malformedLineCount).toBe(1);
    expect(truncated.scannedLineCount).toBe(1);

    // Logged with timestamps off: pino writes the record with no `time` at all.
    const timelessCaseLiveLog = path.join(logDir(), 'brainstrike.log');
    writeFileSync(
      timelessCaseLiveLog,
      `${[
        line('2026-09-15T02:20:00.000Z', 50, 'timestamped'),
        JSON.stringify({ level: 50, msg: 'Unhandled promise rejection' }),
      ].join('\n')}\n`
    );
    await expect(
      readMainLogWindow({ logFilePath: timelessCaseLiveLog, request: window })
    ).rejects.toThrow(/no ISO "time" field/);
  });

  it('accepts only the millisecond instants the log sink writes, so string order is time order', () => {
    const now = Date.parse('2026-09-15T03:00:00.000Z');
    // Assert the FORMAT message: 'since'/'until' alone also appear in the
    // ordering error, which would pass these for the wrong reason.
    const format = 'millisecond ISO-8601 UTC instant';
    // `…00.500Z` < `…00Z` as strings: a whole-second bound would misplace sink lines.
    expect(() =>
      assertMainLogWindowRequest(
        { since: '2026-09-15T02:19:00Z', until: '2026-09-15T02:20:00.000Z' },
        now
      )
    ).toThrow(format);
    expect(() =>
      assertMainLogWindowRequest(
        { since: '2026-09-15T02:19:00.000Z', until: '2026-09-15T02:20:00.5Z' },
        now
      )
    ).toThrow(format);
    // Expanded-year instants round-trip through toISOString but are 27 chars,
    // and sort before every line the sink writes.
    expect(() =>
      assertMainLogWindowRequest(
        { since: '+275760-09-13T00:00:00.000Z', until: '2026-09-15T02:20:00.000Z' },
        now
      )
    ).toThrow(format);
    // 24 chars and parseable, but Date normalizes them to another instant
    // (Feb 30 -> Mar 2, hour 24 -> next midnight), so they are not sink form.
    expect(() =>
      assertMainLogWindowRequest(
        { since: '2026-02-30T00:00:00.000Z', until: '2026-09-15T02:20:00.000Z' },
        now
      )
    ).toThrow(format);
    expect(() =>
      assertMainLogWindowRequest(
        { since: '2026-09-15T02:19:00.000Z', until: '2026-09-15T24:00:00.000Z' },
        now
      )
    ).toThrow(format);
  });

  it('rejects malformed or oversized windows', () => {
    const now = Date.parse('2026-09-15T03:00:00.000Z');
    expect(() =>
      assertMainLogWindowRequest({ since: 'yesterday', until: '2026-09-15T02:00:00.000Z' }, now)
    ).toThrow('since');
    expect(() =>
      assertMainLogWindowRequest({ since: '2026-09-15T02:00:00.000Z', until: 'later' }, now)
    ).toThrow('until');
    expect(() =>
      assertMainLogWindowRequest(
        { since: '2026-09-13T00:00:00.000Z', until: '2026-09-15T02:00:00.000Z' },
        now
      )
    ).toThrow('24 hours');
    expect(() =>
      assertMainLogWindowRequest(
        { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T01:00:00.000Z' },
        now
      )
    ).toThrow('until');
    expect(() =>
      assertMainLogWindowRequest(
        { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T04:00:00.000Z' },
        now
      )
    ).toThrow('future');
    expect(() => assertMainLogWindowRequest(null, now)).toThrow('object');
    expect(() => assertMainLogWindowRequest(['a'], now)).toThrow('object');
    expect(
      assertMainLogWindowRequest(
        { since: '2026-09-15T02:00:00.000Z', until: '2026-09-15T02:30:00.000Z' },
        now
      )
    ).toEqual({
      since: '2026-09-15T02:00:00.000Z',
      until: '2026-09-15T02:30:00.000Z',
    });
  });
});
