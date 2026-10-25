import { createQueryHost } from './host-core.ts';

/** Electron's `MessagePortMain` surface this host uses; the library stays free of Electron types. */
interface UtilityMessagePort {
  on(event: 'message', listener: (event: unknown) => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
}
/** Electron's `ParentPort` surface this host uses. */
interface UtilityParentPort {
  once(event: 'message', listener: (event: unknown) => void): unknown;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every((name) => name in value && typeof Reflect.get(value, name) === 'function')
  );
}

function isMessagePort(value: unknown): value is UtilityMessagePort {
  return hasMethods(value, ['on', 'postMessage', 'start']);
}
function isParentPort(value: unknown): value is UtilityParentPort {
  return hasMethods(value, ['once']);
}

/** The one port Main's fork transferred in its first message (`{ event: 'utility-port' }`). */
function lentPort(event: unknown): UtilityMessagePort {
  const data: unknown =
    typeof event === 'object' && event !== null ? Reflect.get(event, 'data') : null;
  const ports: unknown =
    typeof event === 'object' && event !== null ? Reflect.get(event, 'ports') : null;
  const port: unknown = Array.isArray(ports) && ports.length === 1 ? ports[0] : null;
  if (
    !(
      typeof data === 'object' &&
      data !== null &&
      Reflect.get(data, 'event') === 'utility-port' &&
      isMessagePort(port)
    )
  ) {
    throw new Error('SQLite query utility host expected its one utility port first.');
  }
  return port;
}

if (!('parentPort' in process)) {
  throw new Error('SQLite query utility host requires an Electron parent port.');
}
const parentPort: unknown = process.parentPort;
if (!isParentPort(parentPort)) {
  throw new Error('SQLite query utility host has an invalid Electron parent port.');
}
parentPort.once('message', (first: unknown): void => {
  const port = lentPort(first);
  const receive = createQueryHost((response) => {
    port.postMessage(response);
  });
  port.on('message', (event: unknown): void => {
    if (!(typeof event === 'object' && event !== null && 'data' in event)) {
      process.exit(1);
    }
    receive(event.data);
  });
  port.start();
});
