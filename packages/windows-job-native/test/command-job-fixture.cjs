'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFile, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };

    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit();
    }
  });
}

// A wait() ends with its test: the test's timeout (`--test-timeout`) aborts
// `t.signal`, and a stuck fixture child then fails naming its event and stderr.
// A separate 5 s bound per wait failed loaded Windows runs whose waits were slow,
// not stuck.
function inbox(child, stdout, signal) {
  const messages = [];
  let output = '';
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += data.toString();
  });
  const receive = (message) => {
    messages.push(message);
    child.emit('fixture-message');
  };
  if (stdout) {
    child.stdout.on('data', (data) => {
      output += data.toString();
      let newline = output.indexOf('\n');
      while (newline !== -1) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (line) {
          receive(JSON.parse(line));
        }
        newline = output.indexOf('\n');
      }
    });
  } else {
    child.on('message', receive);
  }
  return {
    child,
    wait: (event) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          signal?.removeEventListener('abort', aborted);
          child.off('fixture-message', check);
          child.off('exit', exited);
          child.off('error', failed);
        };
        const failed = (error) => {
          cleanup();
          reject(error);
        };
        const exited = () => failed(new Error(`Fixture exited before ${event}: ${stderr}`));
        const aborted = () => failed(new Error(`Test ended waiting for ${event}: ${stderr}`));
        const check = () => {
          const error = messages.find((message) => message.event === 'failed');
          const index = messages.findIndex((entry) => entry.event === event);
          const message = index < 0 ? undefined : messages[index];
          if (error) {
            failed(new Error(error.message));
          } else if (message) {
            cleanup();
            messages.splice(index, 1);
            resolve(message);
          }
        };
        signal?.addEventListener('abort', aborted, { once: true });
        child.on('fixture-message', check);
        child.once('exit', exited);
        child.once('error', failed);
        check();
        if (child.exitCode !== null || child.signalCode !== null) {
          exited();
        }
      }),
  };
}

// The observer (test/process_observer.cc, built beside the add-on) pins the
// given PIDs by handle and reports their identities. `check` and `join` wait 0
// and 5000 ms on each pinned process and report the waits and exit codes.
// `deny <mask>` gives the first pinned member a DACL that denies <mask> to
// Everyone, administrators included. `restrict <pid>` removes SeDebugPrivilege
// from that actor's token, because OpenProcess ignores the DACL for it: "If the
// caller has enabled the SeDebugPrivilege privilege, the requested access is
// granted regardless of the contents of the security descriptor."
// https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess
// .NET enables it in any elevated process that uses System.Diagnostics.Process
// (the static ProcessManager constructor in dotnet/runtime), and a child copies
// its parent's token, so a .NET runner or pwsh hands it to the whole test tree.
// Together the two commands make a denial real for whoever runs the test. The
// reply reports the actor's prior state: absent, disabled or enabled.
const observerPath = path.join(__dirname, '..', 'build', 'Release', 'process_observer.exe');

async function collectCleanupErrors(callbacks, failures) {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      failures.push(error);
    }
  }
}

async function commandFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-command-job-'));
  const guards = [];
  const beforeGuardTeardown = [];
  const afterGuardTeardown = [];
  const observers = [];
  t.after(async () => {
    const failures = [];
    await collectCleanupErrors(beforeGuardTeardown, failures);
    for (const guard of guards) {
      if (guard.child.exitCode === null && guard.child.signalCode === null) {
        guard.child.send({ type: 'quit' });
      }
      await waitForChildExit(guard.child);
    }
    await collectCleanupErrors(afterGuardTeardown, failures);
    for (const observer of observers) {
      try {
        observer.child.stdin.write('join\n');
        const joined = await observer.wait('join');
        assert.ok(joined.waits.every((wait) => wait === 0));
      } catch (error) {
        failures.push(error);
      }
      observer.child.stdin.end('release\n');
      await waitForChildExit(observer.child);
      assert.equal(observer.child.exitCode, 0);
    }
    if (failures.length) {
      throw new AggregateError(failures, `Physical cleanup unproved; preserved ${root}`);
    }
    await rm(root, { force: true, recursive: true });
  });
  return {
    afterGuards(finish) {
      afterGuardTeardown.push(finish);
    },
    beforeGuards(release) {
      beforeGuardTeardown.push(release);
    },
    guard(source, extraEnvironment = {}) {
      const child = spawn(
        process.execPath,
        [
          '--expose-gc',
          '-e',
          'const job=require(' +
            JSON.stringify(path.resolve(__dirname, '..')) +
            ');' +
            'process.on("message",(message)=>{if(message.type==="quit")process.exit(0);});' +
            '(async()=>{' +
            source +
            '})().catch(error=>process.send({event:"failed",message:error.stack}));',
        ],
        {
          cwd: root,
          env: { ...process.env, ...extraEnvironment },
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
        }
      );
      const guard = inbox(child, false, t.signal);
      guards.push(guard);
      return guard;
    },
    async observe(pids) {
      const child = spawn(observerPath, [pids.join(',')], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const observer = inbox(child, true, t.signal);
      observers.push(observer);
      const pinned = await observer.wait('pinned');
      observer.pinned = pinned;
      assert.deepEqual(
        pinned.identities.map((identity) => identity.pid),
        pids
      );
      if (process.env.M3_WINDOWS_EVIDENCE_DIR) {
        await appendFile(
          path.join(process.env.M3_WINDOWS_EVIDENCE_DIR, 'command-job-identities.jsonl'),
          `${JSON.stringify({
            event: 'pinned-members',
            identities: pinned.identities,
            test: t.name,
            utc: new Date().toISOString(),
          })}\n`
        );
      }
      return observer;
    },
    root,
  };
}
module.exports = {
  commandFixture,
  inbox,
  waitForChildExit,
};
