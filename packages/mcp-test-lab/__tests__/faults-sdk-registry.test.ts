import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createMcpLabFaultPlan,
  isExecutableProtocolMethod,
  protocolPhaseForMethod,
} from '../src/faults';

interface InstalledSdkEraMethods {
  readonly legacy: ReadonlySet<string>;
  readonly modern: ReadonlySet<string>;
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
    legacy,
    modern,
  };
}

describe('MCP fault compatibility against the installed SDK', () => {
  it('pins the executable client-direction subset to the installed SDK registries', async () => {
    const installed = await readInstalledSdkEraMethods();
    const expected = {
      legacy: [
        'completion/complete',
        'initialize',
        'notifications/cancelled',
        'notifications/initialized',
        'notifications/progress',
        'notifications/roots/list_changed',
        'ping',
        'prompts/get',
        'prompts/list',
        'resources/list',
        'resources/read',
        'tools/call',
        'tools/list',
      ],
      modern: [
        'completion/complete',
        'notifications/cancelled',
        'notifications/progress',
        'prompts/get',
        'prompts/list',
        'resources/list',
        'resources/read',
        'server/discover',
        'subscriptions/listen',
        'tools/call',
        'tools/list',
      ],
    } as const;

    for (const era of ['legacy', 'modern'] as const) {
      const executable = [...installed[era]].filter((method) =>
        isExecutableProtocolMethod(method, era)
      );
      expect(executable.sort()).toEqual([...expected[era]].sort());
      for (const method of expected[era]) {
        expect(installed[era]).toContain(method);
      }
    }

    for (const [era, method] of [
      ['modern', 'notifications/subscriptions/acknowledged'],
      ['legacy', 'notifications/elicitation/complete'],
      ['legacy', 'notifications/tasks/status'],
      ['legacy', 'sampling/createMessage'],
    ] as const) {
      const phase = protocolPhaseForMethod(method);
      if (!phase) {
        throw new Error('Installed MCP SDK method is not represented by the fault vocabulary');
      }
      const plan = createMcpLabFaultPlan([
        {
          fault: { delayMs: 1, kind: 'delay' },
          id: 'unreachable-direction',
          match: { method, occurrence: 1, phase },
        },
      ]);
      expect(() => plan.assertCompatibleWithProtocolEra(era)).not.toThrow();
      expect(() => plan.assertCompatibleWithTransport('http-loopback')).toThrowError(
        /http-loopback transport/iu
      );
    }
  });
});
