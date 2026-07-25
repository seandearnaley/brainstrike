import fs from 'node:fs';
import path from 'node:path';

/** "The live file + 4 rotated siblings" per the Flight Recorder P2a design.
 * `DEFAULT_MAX_FILES` is exported so factory reset (`desktop-factory-reset.ts`,
 * via `listErrorLogFilePaths` in `error-log-sink.ts`) can enumerate every
 * rotated-sibling slot the sink can occupy on disk without duplicating this
 * default. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 5;

export interface RotatingNdjsonSinkOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  /** Called ONCE when the sink disables itself after a failure. */
  readonly onFailure?: (error: unknown) => void;
}

/**
 * Self-contained, fd-owning rotating NDJSON file writer for the Electron main
 * process. This is the durable BACKSTOP for the diagnostics system: it must
 * keep working even when the PGlite diagnostic sink itself is broken, so it
 * has no dependency on the database, on IPC, or — critically — on the logger.
 *
 * NEVER import or call `@brainstrike/utils/logger` (or anything that logs)
 * from this module. The sink is fed BY a log listener (Task 3 taps every log
 * record and forwards it here); logging from inside the sink would re-enter
 * that listener and recurse without bound. Any failure here is reported
 * exactly once through the injected `onFailure` callback instead — the
 * caller decides how to surface it (Task 3 uses a raw `console.error`).
 */
export class RotatingNdjsonSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly onFailure: ((error: unknown) => void) | undefined;

  private currentSize = 0;
  private fd: number | null = null;
  private isDisabled = false;

  constructor(options: RotatingNdjsonSinkOptions) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    // NO SILENT FALLBACKS: a degenerate retention window (maxFiles < 2 means
    // "no room for even one rotated sibling"; maxBytes < 1 means "no line
    // can ever fit") is malformed config, not something to quietly coerce —
    // rotate()'s slot math assumes at least one rotated slot exists. This
    // throws from the constructor, not through `onFailure`: there is no
    // sink instance yet to disable, and misconfiguration should fail the
    // caller's setup immediately rather than surface later as a runtime
    // write failure.
    if (maxFiles < 2) {
      throw new Error(
        `RotatingNdjsonSink: maxFiles must be >= 2 (the live file plus at least one rotated sibling), got ${maxFiles}`
      );
    }
    if (maxBytes < 1) {
      throw new Error(`RotatingNdjsonSink: maxBytes must be >= 1, got ${maxBytes}`);
    }
    this.filePath = options.filePath;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.onFailure = options.onFailure;
  }

  /**
   * `true` once the sink has hit an unrecoverable open/write/rotate failure
   * and permanently stopped writing. This is a deliberate, LOUD self-disable
   * (NO SILENT FALLBACKS) — the caller is told exactly once via `onFailure`
   * at the moment it happens, and can poll this getter forever after.
   */
  get disabled(): boolean {
    return this.isDisabled;
  }

  /**
   * Appends `line + '\n'` to the live file, rotating first if the write
   * would push the live file over `maxBytes`. NEVER throws: the caller is a
   * log listener in the main process, and a throw there would surface as an
   * unhandled error inside logging itself. Any failure — opening, rotating,
   * or writing — permanently disables the sink instead (see `disable`).
   */
  writeLine(line: string): void {
    if (this.isDisabled) {
      return;
    }
    try {
      let fd = this.ensureOpen();
      const buffer = Buffer.from(`${line}\n`, 'utf8');
      if (this.currentSize > 0 && this.currentSize + buffer.byteLength > this.maxBytes) {
        fd = this.rotate();
      }
      const bytesWritten = fs.writeSync(fd, buffer);
      if (bytesWritten !== buffer.byteLength) {
        // fs.writeSync can write fewer bytes than requested (signal
        // interruption, RLIMIT_FSIZE, an ENOSPC boundary, …). Silently
        // continuing would land a TRUNCATED NDJSON line on disk and over-
        // count `currentSize` by the untracked remainder. Treat it exactly
        // like any other write failure: throw so the catch below disables
        // the sink and reports it — a truncated durable record must
        // surface, never pass silently.
        throw new Error(
          `RotatingNdjsonSink: short write to "${this.filePath}" (${bytesWritten}/${buffer.byteLength} bytes)`
        );
      }
      this.currentSize += buffer.byteLength;
    } catch (error) {
      this.disable(error);
    }
  }

  /**
   * Idempotent: closes the fd if open. Safe to call multiple times.
   *
   * Does NOT disable the sink. A `writeLine` call after `close()`
   * transparently reopens the file (re-seeding `currentSize` from disk) and
   * keeps writing — this class itself never drops a post-close write.
   *
   * CHOSEN, NOT ACCIDENTAL, and reachable via two different desktop callers
   * with two different intents:
   *
   * - Graceful shutdown (`main.ts`'s `error-log-sink` shutdown step) calls
   *   `close()` and then sets its `errorLogSink` handle to `null` in the
   *   SAME step (see the comment there), so `recordDurableLog` becomes a
   *   permanent no-op after that point rather than exercising this reopen
   *   path — e.g. a shutdown-timeout error logged later by
   *   `scheduleForcedProcessExit` reaches console/`brainstrike.log` but NOT
   *   this NDJSON file. That null-out is deliberate (see
   *   `docs/agents/platform-contracts.md`'s P2a section).
   * - Factory reset (`main.ts`'s `error-log-sink` reset-runtime disposer)
   *   calls `close()` WITHOUT nulling `errorLogSink`, specifically so this
   *   reopen affordance fires: the reset's purge step deletes the NDJSON
   *   file right after every runtime disposer (including this one) has run,
   *   and the next warn+ record after that transparently recreates the file
   *   from scratch instead of the sink going permanently silent. This is the
   *   first production path that actually exercises the reopen behavior —
   *   it was previously reachable only from this class's own tests.
   */
  close(): void {
    if (this.fd === null) {
      return;
    }
    const fd = this.fd;
    // Untrack BEFORE the syscall, not after: if fs.closeSync throws
    // (EBADF/EIO), `fd` must still end up untracked. Otherwise a second
    // close() would try to re-close the same already-invalid descriptor,
    // and a later writeLine would believe it still owns a live fd instead
    // of correctly reopening.
    this.fd = null;
    fs.closeSync(fd);
  }

  private ensureOpen(): number {
    if (this.fd !== null) {
      return this.fd;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fd = fs.openSync(this.filePath, 'a');
    this.fd = fd;
    // Seed from the file's actual size — NOT 0 — so a reopen after a
    // process restart continues the same rotation budget instead of
    // silently growing the live file past maxBytes before the next
    // rotation check has a chance to fire.
    this.currentSize = fs.fstatSync(fd).size;
    return fd;
  }

  /**
   * Rotates the live file into `<filePath>.1`, shifting existing rotated
   * siblings up by one slot: `.1`→`.2`, `.2`→`.3`, etc. The highest slot
   * (`<filePath>.<maxFiles - 1>`) holds the oldest retained data; instead of
   * renaming it one slot further out (which would grow the retention window
   * without bound — a real file `.<maxFiles>` would then exist forever), it
   * is dropped, and the next-oldest sibling is promoted into its place. This
   * keeps the file count at exactly `maxFiles` (the live file plus
   * `maxFiles - 1` rotated siblings) forever.
   */
  private rotate(): number {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    const highestIndex = this.maxFiles - 1;
    for (let index = highestIndex; index >= 1; index -= 1) {
      const source = this.rotatedPath(index);
      if (!fs.existsSync(source)) {
        continue;
      }
      if (index === highestIndex) {
        fs.rmSync(source, { force: true });
      } else {
        fs.renameSync(source, this.rotatedPath(index + 1));
      }
    }
    if (fs.existsSync(this.filePath)) {
      fs.renameSync(this.filePath, this.rotatedPath(1));
    }
    return this.ensureOpen();
  }

  private rotatedPath(index: number): string {
    return `${this.filePath}.${index}`;
  }

  /**
   * Permanently disables the sink after any open/write/rotate failure and
   * reports it exactly once via `onFailure`. Every later `writeLine` becomes
   * a silent no-op so the caller's log listener never throws.
   */
  private disable(error: unknown): void {
    if (this.isDisabled) {
      return;
    }
    this.isDisabled = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Best-effort cleanup only — the sink is already disabled and the
        // original failure already reported; nothing more to surface here.
      }
      this.fd = null;
    }
    try {
      this.onFailure?.(error);
    } catch {
      // `writeLine` must NEVER throw, even if the caller's own onFailure
      // handler is buggy. `onFailure` has already been invoked (its
      // contract is satisfied); a broken handler must not surface here.
    }
  }
}
