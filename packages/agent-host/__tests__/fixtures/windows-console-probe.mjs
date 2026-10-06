const [mode, ...args] = process.argv.slice(2);
if (mode === 'reject') {
  process.stderr.write('Recorded fixture startup rejection\n');
  process.exitCode = 7;
} else {
  const timer = setInterval(() => undefined, 1000);
  process.stdin.resume();
  process.on('SIGINT', () => {
    process.stdout.write('actual-console-SIGINT\n');
    clearInterval(timer);
    process.stdin.pause();
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (text) => process.stdout.write(`echo:${text}`));
  process.stdout.write(
    `${JSON.stringify({ args, event: 'probe-ready', executable: process.execPath, pid: process.pid })}\n`
  );
}
