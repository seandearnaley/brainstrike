import { afterEach, describe, expect, it, vi } from 'vitest';

const setupPath = '../src/vitest.setup';
const originalTextEncoder = global.TextEncoder;
const consoleErrorAtTestDefinition = console.error;

afterEach(() => {
  vi.resetModules();
  global.TextEncoder = originalTextEncoder;
});

describe('vitest.setup TextEncoder handling', () => {
  it('leaves console.error intact so React act warnings remain observable', () => {
    expect(console.error).toBe(consoleErrorAtTestDefinition);
  });

  it('does not overwrite an existing TextEncoder', async () => {
    class CustomTextEncoder {
      encode(_input?: string): Uint8Array {
        return new Uint8Array();
      }
    }
    global.TextEncoder = CustomTextEncoder as unknown as typeof global.TextEncoder;

    await import(setupPath);

    expect(global.TextEncoder).toBe(CustomTextEncoder);
  });

  it('assigns a mock TextEncoder when missing', async () => {
    // Temporarily remove TextEncoder to simulate it being missing
    Object.defineProperty(global, 'TextEncoder', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    await import(setupPath);

    expect(global.TextEncoder).toBeDefined();
    expect(global.TextEncoder).not.toBe(originalTextEncoder);
    expect(global.TextEncoder.name).toBe('MockTextEncoder');
  });
});
