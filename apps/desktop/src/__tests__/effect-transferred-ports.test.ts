import { EventEmitter } from 'node:events';
import { Schema } from 'effect';
import { expect, it, vi } from 'vitest';
import { PlatformMessagePortSchema } from '../agent-host-platform/connection';
import { bindDesktopClientPort } from '../agent-host-platform/desktop-client-port';
import {
  installParentPlatformPort,
  parentPlatformPort,
} from '../agent-host-platform/parent-platform-port';
import { installHostLifetimePort } from '../host-lifetime-port';

class Port extends EventEmitter {
  close = vi.fn();
  postMessage = vi.fn();
  start = vi.fn();
}
it('retains transferred prototype, identity and callable capabilities', async () => {
  const port = new Port();
  expect(Schema.decodeUnknownSync(PlatformMessagePortSchema)(port)).toBe(port);
  expect(
    bindDesktopClientPort(
      { data: { event: 'client-port' }, ports: [port], transportRider: true },
      undefined
    )
  ).toBe(true);
  expect(port.close).toHaveBeenCalledOnce();
  expect(
    installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [port] })
  ).toBe(true);
  expect(await parentPlatformPort()).toBe(port);
  const lost = vi.fn();
  expect(installHostLifetimePort({ data: { event: 'lifetime' }, ports: [port] }, lost)).toBe(true);
  port.emit('close');
  expect(lost).toHaveBeenCalledOnce();
  expect(port.start).toHaveBeenCalledOnce();
});
it('refuses malformed capabilities, extra ports and event riders before side effects', () => {
  const port = new Port();
  for (const ports of [[], [port, port], [{ on: 2, postMessage: 1 }]]) {
    expect(bindDesktopClientPort({ data: { event: 'client-port' }, ports }, undefined)).toBe(false);
  }
  expect(
    bindDesktopClientPort({ data: { event: 'client-port', rider: true }, ports: [port] }, undefined)
  ).toBe(false);
  expect(
    installHostLifetimePort({ data: { event: 'lifetime' }, ports: [{ on: 1, start: 2 }] }, vi.fn())
  ).toBe(false);
  expect(port.close).not.toHaveBeenCalled();
});
