/**
 * The host utility's end of its lifetime channel (ADR-0017: a host forked by the app dies with the
 * app). Electron Main keeps the other end until it has joined the host, so this port's 'close'
 * means Main let the host go or Main's process died (MessagePortMain 'close': "the remote end ...
 * becomes disconnected"). On POSIX Chromium also ends a utility at once when Main dies; Windows has
 * no such tie for an unsandboxed utility, and parentPort itself reports no disconnect.
 */
import { z } from 'zod';

interface LifetimePort {
  on(event: 'close', listener: () => void): unknown;
  start(): void;
}
const Message = z.object({
  data: z.strictObject({ event: z.literal('lifetime') }),
  ports: z
    .array(
      z.custom<LifetimePort>(
        (value) => typeof value === 'object' && value !== null && 'on' in value && 'start' in value
      )
    )
    .length(1),
});

/** True when `input` was Main's lifetime port, whose close now runs `lost`. */
export function installHostLifetimePort(input: unknown, lost: () => void): boolean {
  const message = Message.safeParse(input);
  if (!message.success) {
    return false;
  }
  const port = message.data.ports[0];
  if (!port) {
    throw new Error('Host lifetime message has no transferred port');
  }
  port.on('close', lost);
  port.start();
  return true;
}
