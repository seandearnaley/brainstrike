import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DESKTOP_PORT,
  DEFAULT_PORT,
  DEFAULT_WEB_PORT,
  DESKTOP_PORT_RANGE,
  getBaseUrl,
  getDesktopBaseUrl,
  getDesktopPortsToCheck,
  getPortsToCheck,
  getWebBaseUrl,
  getWebPortsToCheck,
  PORT_RANGE,
  WEB_PORT_RANGE,
} from '../server';

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
    expect(ports.at(-1)).toBe(PORT_RANGE.end);
  });

  test('getWebPortsToCheck should return array of web ports', () => {
    const ports = getWebPortsToCheck();
    expect(Array.isArray(ports)).toBe(true);
    expect(ports.length).toBe(WEB_PORT_RANGE.end - WEB_PORT_RANGE.start + 1);
    expect(ports[0]).toBe(WEB_PORT_RANGE.start);
    expect(ports.at(-1)).toBe(WEB_PORT_RANGE.end);
  });

  test('getDesktopPortsToCheck should return array of desktop ports', () => {
    const ports = getDesktopPortsToCheck();
    expect(Array.isArray(ports)).toBe(true);
    expect(ports.length).toBe(DESKTOP_PORT_RANGE.end - DESKTOP_PORT_RANGE.start + 1);
    expect(ports[0]).toBe(DESKTOP_PORT_RANGE.start);
    expect(ports.at(-1)).toBe(DESKTOP_PORT_RANGE.end);
  });

  test('getWebBaseUrl should return correct URL format', () => {
    const url = getWebBaseUrl(3000);
    expect(url).toBe('http://localhost:3000');
  });

  test('getWebBaseUrl should use default web port when no port provided', () => {
    const url = getWebBaseUrl();
    expect(url).toBe(`http://localhost:${DEFAULT_WEB_PORT}`);
  });

  test('getDesktopBaseUrl should return correct URL format', () => {
    const url = getDesktopBaseUrl(3001);
    expect(url).toBe('http://localhost:3001');
  });

  test('getDesktopBaseUrl should use default desktop port when no port provided', () => {
    const url = getDesktopBaseUrl();
    expect(url).toBe(`http://localhost:${DEFAULT_DESKTOP_PORT}`);
  });
});

describe('environment variable handling', () => {
  const originalEnv = globalThis.process?.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (globalThis.process) {
      globalThis.process.env = originalEnv;
    }
  });

  test('should use PORT environment variable when set', async () => {
    if (globalThis.process) {
      globalThis.process.env = { ...originalEnv, PORT: '9090' };
    }
    const { DEFAULT_WEB_PORT: webPort } = await import('../server');
    expect(webPort).toBe(9090);
  });

  test('should use DESKTOP_PORT environment variable when set', async () => {
    if (globalThis.process) {
      globalThis.process.env = { ...originalEnv, DESKTOP_PORT: '9091' };
    }
    const { DEFAULT_DESKTOP_PORT: desktopPort } = await import('../server');
    expect(desktopPort).toBe(9091);
  });

  test('should use default ports when environment variables are not set', async () => {
    if (globalThis.process) {
      globalThis.process.env = { ...originalEnv };
      const port = 'PORT';
      const desktopPort = 'DESKTOP_PORT';
      delete globalThis.process.env[port];
      delete globalThis.process.env[desktopPort];
    }
    const { DEFAULT_WEB_PORT: webPort, DEFAULT_DESKTOP_PORT: desktopPort } = await import(
      '../server'
    );
    expect(webPort).toBe(8080);
    expect(desktopPort).toBe(8081);
  });

  test.each([
    ['PORT', '9090abc'],
    ['DESKTOP_PORT', '9091.5'],
  ])('should reject malformed %s environment values', async (name, value) => {
    if (globalThis.process) {
      globalThis.process.env = { ...originalEnv, [name]: value };
    }
    await expect(import('../server')).rejects.toThrow(
      `${name} must be a positive integer, received "${value}".`
    );
  });

  test.each([
    'PORT',
    'DESKTOP_PORT',
  ])('should reject %s values above the TCP port ceiling', async (name) => {
    if (globalThis.process) {
      globalThis.process.env = { ...originalEnv, [name]: '65536' };
    }
    await expect(import('../server')).rejects.toThrow(
      `${name} must be <= 65535, received "65536".`
    );
  });
});
