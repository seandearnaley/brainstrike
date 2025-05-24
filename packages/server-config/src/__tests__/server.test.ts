import { describe, expect, test } from 'vitest';
import { DEFAULT_PORT, PORT_RANGE, getBaseUrl, getPortsToCheck } from '../server';

describe('server configuration', () => {
  test('DEFAULT_PORT should be a number', () => {
    expect(typeof DEFAULT_PORT).toBe('number');
    expect(DEFAULT_PORT).toBeGreaterThan(0);
  });

  test('PORT_RANGE should have valid start and end', () => {
    expect(PORT_RANGE.start).toBe(DEFAULT_PORT);
    expect(PORT_RANGE.end).toBeGreaterThan(PORT_RANGE.start);
  });

  test('getBaseUrl should return correct URL format', () => {
    const url = getBaseUrl(3000);
    expect(url).toBe('http://localhost:3000');
  });

  test('getBaseUrl should use default port when no port provided', () => {
    const url = getBaseUrl();
    expect(url).toBe(`http://localhost:${DEFAULT_PORT}`);
  });

  test('getPortsToCheck should return array of ports', () => {
    const ports = getPortsToCheck();
    expect(Array.isArray(ports)).toBe(true);
    expect(ports.length).toBeGreaterThan(0);
    expect(ports[0]).toBe(PORT_RANGE.start);
    expect(ports[ports.length - 1]).toBe(PORT_RANGE.end);
  });
});
