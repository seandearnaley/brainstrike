import { describe, expect, it } from 'vitest';
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_INVOKE_CHANNEL,
  DESKTOP_IPC_PUSH_CHANNEL,
} from '../../platform/desktop-ipc-channels';
import { LOGGING_API_CHANNELS } from '../../platform/logging-api-contract';

describe('desktop IPC channel contract', () => {
  it('keeps the logging API methods owned by the manifest', () => {
    expect(LOGGING_API_CHANNELS).toBe(DESKTOP_IPC_CHANNELS.logging);
  });

  it('gives every method one route on the one connection', () => {
    const methods = Object.values(DESKTOP_IPC_CHANNELS).flatMap((group) => Object.values(group));
    expect(new Set(methods).size).toBe(methods.length);
    expect(DESKTOP_IPC_INVOKE_CHANNEL).not.toBe(DESKTOP_IPC_PUSH_CHANNEL);
    expect(methods).not.toContain(DESKTOP_IPC_INVOKE_CHANNEL);
    expect(methods).not.toContain(DESKTOP_IPC_PUSH_CHANNEL);
  });
});
