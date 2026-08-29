import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  getMcpLabScenario,
  MCP_LAB_CONFORMANCE_SOURCE,
  MCP_LAB_CONFORMANCE_VERSION,
  MCP_LAB_SCENARIO_IDS,
  MCP_LAB_SDK_SOURCE,
  MCP_LAB_SDK_SOURCE_SHA,
  MCP_LAB_SDK_VERSION,
} from '../src/scenario';

function readInstalledPackageVersion(packageName: string): string {
  const manifestPath = findPackageJSON(packageName, import.meta.url);
  if (!manifestPath) {
    throw new Error(`Cannot find installed package manifest for ${packageName}`);
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error(`Installed package manifest for ${packageName} has no string version`);
  }
  return manifest.version;
}

describe('MCP lab scenario manifest', () => {
  it('declares the Brainstrike fixture and pinned official version/tag metadata', () => {
    expect(getMcpLabScenario('modern-reference')).toEqual({
      authentication: 'none',
      availability: 'declared',
      description: 'Declared modern reference contract; executable transport lands in BST-1480',
      fixture: 'brainstrike-sdk-v2-reference',
      id: 'modern-reference',
      network: 'loopback-only',
      protocol: { era: 'modern', version: '2026-07-28' },
      reference: {
        clientPackage: '@modelcontextprotocol/client',
        conformancePackage: '@modelcontextprotocol/conformance',
        conformanceSource: MCP_LAB_CONFORMANCE_SOURCE,
        conformanceVersion: MCP_LAB_CONFORMANCE_VERSION,
        sdkSource: MCP_LAB_SDK_SOURCE,
        sdkSourceSha: MCP_LAB_SDK_SOURCE_SHA,
        sdkVersion: MCP_LAB_SDK_VERSION,
        serverPackage: '@modelcontextprotocol/server',
      },
      transport: 'streamable-http',
      usesAmbientCredentials: false,
    });
  });

  it('matches the real installed client, server, and conformance package versions', () => {
    expect(typeof Client).toBe('function');
    expect(readInstalledPackageVersion('@modelcontextprotocol/client')).toBe(MCP_LAB_SDK_VERSION);
    expect(readInstalledPackageVersion('@modelcontextprotocol/server')).toBe(MCP_LAB_SDK_VERSION);
    expect(readInstalledPackageVersion('@modelcontextprotocol/conformance')).toBe(
      MCP_LAB_CONFORMANCE_VERSION
    );
  });

  it('declares an independently verifiable upstream source tag and peeled commit', () => {
    expect(MCP_LAB_SDK_SOURCE).toEqual({
      commitSha: 'cc4b41617ce3601b1290d67216ea0b194a3cd9ac',
      repositoryUrl: 'https://github.com/modelcontextprotocol/typescript-sdk.git',
      tag: '@modelcontextprotocol/server@2.0.0',
    });
    expect(getMcpLabScenario('modern-reference').reference.sdkSource).toBe(MCP_LAB_SDK_SOURCE);
    expect(MCP_LAB_CONFORMANCE_SOURCE).toEqual({
      commitSha: 'a9896553900a2ef61787b57adfcbbe936a8ab1f9',
      integrity:
        'sha512-0V/HZDdWHcg6j0zVBzBsXcPZ571IVi6umKgTpnBhtTx/jm/LONmGF6cIWL2k4Xjyps0OiHV6B37nj2s0pUg0nQ==',
      repositoryUrl: 'https://github.com/modelcontextprotocol/conformance.git',
    });
    expect(getMcpLabScenario('modern-reference').reference.conformanceSource).toBe(
      MCP_LAB_CONFORMANCE_SOURCE
    );
    const lockfile = readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');
    expect(lockfile).toContain(MCP_LAB_CONFORMANCE_SOURCE.integrity.slice('sha512-'.length));
  });

  it('returns a deeply frozen shared manifest', () => {
    expect(Object.isFrozen(MCP_LAB_SCENARIO_IDS)).toBe(true);
    for (const id of MCP_LAB_SCENARIO_IDS) {
      const manifest = getMcpLabScenario(id);
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.protocol)).toBe(true);
      expect(Object.isFrozen(manifest.reference)).toBe(true);
      expect(Object.isFrozen(manifest.reference.sdkSource)).toBe(true);
    }

    const scenario = getMcpLabScenario('modern-reference');

    expect(Reflect.set(scenario, 'transport', 'stdio')).toBe(false);
    expect(Reflect.set(scenario.protocol, 'version', 'mutated')).toBe(false);
    expect(Reflect.set(scenario.reference.sdkSource, 'commitSha', 'mutated')).toBe(false);
    expect(getMcpLabScenario('modern-reference').transport).toBe('streamable-http');
  });

  it('publishes unique scenario ids in deterministic order', () => {
    expect(MCP_LAB_SCENARIO_IDS).toEqual([
      'modern-reference',
      'legacy-reference',
      'stdio-reference',
      'oauth-reference',
    ]);
    expect(new Set(MCP_LAB_SCENARIO_IDS).size).toBe(MCP_LAB_SCENARIO_IDS.length);
    for (const id of MCP_LAB_SCENARIO_IDS) {
      expect(getMcpLabScenario(id).availability).toBe('declared');
    }
  });

  it('rejects an unknown scenario instead of selecting a default', () => {
    expect(() => getMcpLabScenario('missing')).toThrow('Unknown MCP lab scenario: missing');
  });
});
