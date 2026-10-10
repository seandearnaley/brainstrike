import { createRequire } from 'node:module';
import { app, dialog, utilityProcess } from 'electron';

const report = (event: string, detail: unknown): void => {
  process.stdout.write(`${JSON.stringify({ detail, event })}\n`);
};
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (...args) => {
  report('fork', null);
  const child = fork(...args);
  child.once('spawn', () => report('spawn', child.pid));
  child.once('exit', (code) => report('utility-exit', code));
  return child;
};
const exit = app.exit.bind(app);
app.exit = (code) => {
  report('app-exit', code);
  exit(code);
};
dialog.showErrorBox = (_title, content) => report('failure', content);
// This fixture sits beside the real emitted CJS entries in a disposable build.
// biome-ignore lint/correctness/noGlobalDirnameFilename: the fixture is emitted as CJS, like Main.
createRequire(__filename)('./main.js');
