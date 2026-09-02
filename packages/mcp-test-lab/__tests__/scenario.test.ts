import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { McpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';
import {
  getMcpLabScenario,
  MCP_LAB_CONFORMANCE_SOURCE,
  MCP_LAB_CONFORMANCE_VERSION,
  MCP_LAB_OFFICIAL_EVERYTHING_PROFILE_SOURCE,
  MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE,
  MCP_LAB_SCENARIO_IDS,
  MCP_LAB_SDK_SOURCE,
  MCP_LAB_SDK_SOURCE_SHA,
  MCP_LAB_SDK_VERSION,
} from '../src/scenario';

type AcceptsHttpWithoutExecution = typeof startMcpLabScenario extends (
  id: 'modern-reference',
  options: Record<string, never>
) => unknown
  ? true
  : false;
type AcceptsStdioExecution = typeof startMcpLabScenario extends (
  id: 'stdio-reference',
  options: { readonly execution: 'loopback' }
) => unknown
  ? true
  : false;
type AcceptsStdioFaultAndExecution = typeof startMcpLabScenario extends (
  id: 'stdio-reference',
  options: { readonly execution: 'loopback'; readonly faultPlan: McpLabFaultPlan }
) => unknown
  ? true
  : false;
type AcceptsStdioUndefinedExecution = typeof startMcpLabScenario extends (
  id: 'stdio-reference',
  options: { readonly execution: undefined; readonly faultPlan: McpLabFaultPlan }
) => unknown
  ? true
  : false;

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
  it('keeps stdio optionless and HTTP execution explicit at the type boundary', () => {
    expectTypeOf(startMcpLabScenario).toBeCallableWith('stdio-reference');
    expectTypeOf(startMcpLabScenario).toBeCallableWith('modern-reference', {
      execution: 'in-process',
    });
    expectTypeOf<AcceptsHttpWithoutExecution>().toEqualTypeOf<false>();
    expectTypeOf<AcceptsStdioExecution>().toEqualTypeOf<false>();
    expectTypeOf<AcceptsStdioFaultAndExecution>().toEqualTypeOf<false>();
    expectTypeOf<AcceptsStdioUndefinedExecution>().toEqualTypeOf<false>();
  });

  it('declares the pinned official modern fixture and version/tag metadata', () => {
    expect(getMcpLabScenario('modern-reference')).toEqual({
      authentication: 'none',
      availability: 'executable',
      description: 'Executable modern reference based on the official SDK v2 everything server',
      fixture: 'official-sdk-v2-everything-reference',
      fixtureSource: MCP_LAB_OFFICIAL_EVERYTHING_PROFILE_SOURCE,
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
    expect(MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE).toEqual({
      commitSha: 'cc4b41617ce3601b1290d67216ea0b194a3cd9ac',
      kind: 'official-typescript-sdk',
      path: 'test/conformance/src/everythingServer.ts',
      repositoryUrl: 'https://github.com/modelcontextprotocol/typescript-sdk.git',
      sha256: '3a94417774fa20b17971e8162f9865b1cefd2650c7d88fdcd17f971d91213852',
    });
    expect(MCP_LAB_OFFICIAL_EVERYTHING_PROFILE_SOURCE).toMatchObject({
      kind: 'brainstrike-owned-derived-profile',
      path: 'packages/mcp-test-lab/src/official-everything-profile.ts',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      upstream: MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE,
    });
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
      expect(Object.isFrozen(manifest.fixtureSource)).toBe(true);
      expect(Object.isFrozen(manifest.reference.sdkSource)).toBe(true);
    }

    const scenario = getMcpLabScenario('modern-reference');

    expect(Reflect.set(scenario, 'transport', 'stdio')).toBe(false);
    expect(Reflect.set(scenario.protocol, 'version', 'mutated')).toBe(false);
    expect(Reflect.set(scenario.reference.sdkSource, 'commitSha', 'mutated')).toBe(false);
    expect(Reflect.set(scenario.fixtureSource, 'path', 'mutated')).toBe(false);
    expect(getMcpLabScenario('modern-reference').transport).toBe('streamable-http');
  });

  it('publishes unique scenario ids in deterministic order', () => {
    expect(MCP_LAB_SCENARIO_IDS).toEqual([
      'modern-reference',
      'legacy-reference',
      'stdio-reference',
      'oauth-reference',
      'tasks-reference',
      'apps-reference',
    ]);
    expect(new Set(MCP_LAB_SCENARIO_IDS).size).toBe(MCP_LAB_SCENARIO_IDS.length);
    expect(MCP_LAB_SCENARIO_IDS.map((id) => [id, getMcpLabScenario(id).availability])).toEqual([
      ['modern-reference', 'executable'],
      ['legacy-reference', 'executable'],
      ['stdio-reference', 'executable'],
      ['oauth-reference', 'executable'],
      ['tasks-reference', 'executable'],
      ['apps-reference', 'executable'],
    ]);
  });

  it('rejects an unknown scenario instead of selecting a default', () => {
    expect(() => getMcpLabScenario('missing')).toThrow('Unknown MCP lab scenario: missing');
  });
});
