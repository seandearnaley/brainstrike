'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { test } = require('node:test');
const { getCurrentProcessIdentity, getProcessCreationTime } = require('..');
const windows = { skip: process.platform !== 'win32' };

test(
  'creation FILETIME matches the existing OS formatter and excludes an exited pinned process',
  windows,
  async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.send("ready"); process.on("message",()=>process.exit(0));'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      }
    );
    const exited = once(child, 'exit');
    let holder;
    let holderExited;
    let lines;
    try {
      await once(child, 'message');
      const creation = getProcessCreationTime(child.pid);
      assert.match(creation, /^\d+$/);
      assert.equal(getProcessCreationTime(process.pid), getCurrentProcessIdentity().creationTime);
      // Keep an OS process handle open past exit. GetProcessTimes still returns
      // creation time on that handle; it must never imply that the owner is live.
      holder = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${child.pid}); $handle=$p.Handle; [Console]::WriteLine('HELD '+$p.StartTime.ToFileTimeUtc()); [Console]::ReadLine() > $null; [Console]::WriteLine('AFTER '+$p.StartTime.ToFileTimeUtc()); [Console]::ReadLine() > $null; $p.Dispose();`,
        ],
        { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }
      );
      holderExited = once(holder, 'exit');
      lines = createInterface({ input: holder.stdout });
      const output = lines[Symbol.asyncIterator]();
      assert.equal((await output.next()).value, `HELD ${creation}`);
      child.send('exit');
      await exited;
      assert.equal(getProcessCreationTime(child.pid), null);
      holder.stdin.write('observe\n');
      assert.equal((await output.next()).value, `AFTER ${creation}`);
      holder.stdin.end('release\n');
      assert.deepEqual(await holderExited, [0, null]);
    } finally {
      lines?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await exited;
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        holder.kill();
      }
      if (holderExited) {
        await holderExited;
      }
    }
  }
);

test('process identity refuses invalid PIDs and inaccessible system owners', windows, () => {
  for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 32, '1']) {
    assert.throws(() => getProcessCreationTime(pid), TypeError);
  }
  // OpenProcess documents access denial for the System process. A denial is
  // an error, never evidence that its PID is gone.
  assert.throws(() => getProcessCreationTime(4));
});
