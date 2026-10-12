import { resolve } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';

test('the emitted bootstrap and full Main share their profile and process-wide owners', async ({
  electronApp,
}) => {
  const ownership = await electronApp.app.evaluate(
    (_electron, mainEntry) => {
      const requireMain = process.getBuiltinModule('module').createRequire(mainEntry);
      const byName = (name: string): NodeJS.Module => {
        const module = requireMain.cache[requireMain.resolve(`./${name}.js`)];
        if (!module) {
          throw new Error(`Expected the emitted ${name} owner`);
        }
        return module;
      };
      const bootstrap = byName('main');
      const main = byName('main-runtime');
      const runtime = byName('desktop-bootstrap-runtime');
      const environment = byName('desktop-env');
      const location = byName('desktop-database-location');
      const shutdown = byName('desktop-shutdown-state');
      const logging = requireMain.cache[requireMain.resolve('@brainstrike/logging')];
      if (!logging) {
        throw new Error('Expected the shared process logger module');
      }
      return {
        bootstrapRuntime: bootstrap.children.includes(runtime),
        environment:
          bootstrap.children.includes(environment) && runtime.children.includes(environment),
        location: runtime.children.includes(location) && main.children.includes(location),
        logging: runtime.children.includes(logging) && main.children.includes(logging),
        mainRuntime: main.children.includes(runtime),
        shutdown:
          bootstrap.children.includes(shutdown) &&
          main.children.includes(shutdown) &&
          runtime.children.includes(shutdown),
      };
    },
    resolve(import.meta.dirname, '../dist/main.js')
  );
  expect(ownership).toEqual({
    bootstrapRuntime: true,
    environment: true,
    location: true,
    logging: true,
    mainRuntime: true,
    shutdown: true,
  });
});
