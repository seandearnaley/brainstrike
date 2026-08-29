import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan, protocolPhaseForMethod } from '../src/faults';

interface InstalledSdkEraMethods {
  readonly legacyOnly: readonly string[];
  readonly modernOnly: readonly string[];
}

function readRegistryMethods(
  source: string,
  requestName: string,
  notificationName: string
): Set<string> {
  const methods = new Set<string>();
  for (const name of [requestName, notificationName]) {
    const startMarker = `const ${name} = {`;
    const start = source.indexOf(startMarker);
    if (start === -1) {
      throw new Error('Installed MCP SDK registry object is missing');
    }
    const end = source.indexOf('\n};', start + startMarker.length);
    if (end === -1) {
      throw new Error('Installed MCP SDK registry object is unterminated');
    }
    const objectSource = source.slice(start + startMarker.length, end);
    for (const match of objectSource.matchAll(
      /(?:^|\n)\s*(?:"([^"]+)"|([A-Za-z][A-Za-z0-9]*)):\s*null,?/gu
    )) {
      const method = match[1] ?? match[2];
      if (method === undefined) {
        throw new Error('Installed MCP SDK registry key is unreadable');
      }
      methods.add(method);
    }
  }
  return methods;
}

async function readInstalledSdkEraMethods(): Promise<InstalledSdkEraMethods> {
  const entryUrl = new URL(import.meta.resolve('@modelcontextprotocol/client'));
  const entrySource = await readFile(entryUrl, 'utf8');
  const chunkName = /from "\.\/(src-[^"]+\.mjs)";/u.exec(entrySource)?.[1];
  if (chunkName === undefined) {
    throw new Error('Installed MCP SDK registry chunk is missing');
  }
  const chunkSource = await readFile(new URL(chunkName, entryUrl), 'utf8');
  const legacyMarker = '//#region ../core-internal/src/wire/rev2025-11-25/registry.ts';
  const modernMarker = '//#region ../core-internal/src/wire/rev2026-07-28/registry.ts';
  const legacyStart = chunkSource.indexOf(legacyMarker);
  const modernStart = chunkSource.indexOf(modernMarker);
  if (legacyStart === -1 || modernStart === -1 || legacyStart >= modernStart) {
    throw new Error('Installed MCP SDK era registries are missing');
  }
  const legacy = readRegistryMethods(
    chunkSource.slice(legacyStart, modernStart),
    'requestMethodKeys$1',
    'notificationMethodKeys$1'
  );
  const modern = readRegistryMethods(
    chunkSource.slice(modernStart),
    'requestMethodKeys',
    'notificationMethodKeys'
  );
  return {
    legacyOnly: [...legacy].filter((method) => !modern.has(method)).sort(),
    modernOnly: [...modern].filter((method) => !legacy.has(method)).sort(),
  };
}

describe('MCP fault compatibility against the installed SDK', () => {
  it('derives protocol-era differences from the pinned SDK registries', async () => {
    const { legacyOnly, modernOnly } = await readInstalledSdkEraMethods();
    expect(legacyOnly.length).toBeGreaterThan(0);
    expect(modernOnly.length).toBeGreaterThan(0);

    for (const [era, methods] of [
      ['legacy', legacyOnly],
      ['modern', modernOnly],
    ] as const) {
      for (const method of methods) {
        const phase = protocolPhaseForMethod(method);
        if (!phase) {
          throw new Error('Installed MCP SDK registry contains an unmapped protocol method');
        }
        const plan = createMcpLabFaultPlan([
          {
            fault: { delayMs: 1, kind: 'delay' },
            id: `${era}-only`,
            match: { method, occurrence: 1, phase },
          },
        ] as never);

        const incompatibleEra = era === 'legacy' ? 'modern' : 'legacy';
        expect(() => plan.assertCompatibleWithProtocolEra(incompatibleEra)).toThrowError(
          new RegExp(`${incompatibleEra} protocol`, 'iu')
        );
        expect(() => plan.assertCompatibleWithProtocolEra(era)).not.toThrow();
      }
    }
  });
});
