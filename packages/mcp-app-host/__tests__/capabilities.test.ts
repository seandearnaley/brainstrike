import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MCP_APPS_CLIENT_CAPABILITY,
  MCP_APPS_CONTRACT_SOURCE,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  MCP_APPS_PINNED_SCHEMA_UI_METHODS,
  MCP_APPS_SCHEMA_EXCLUSIONS,
  MCP_APPS_SPEC_VERSION,
  MCP_APPS_STABLE_UI_METHODS,
  parseMcpAppsClientCapability,
} from '../src/index.js';

async function readInstalledExtAppsMetadata(): Promise<{
  readonly schemaMethods: readonly string[];
  readonly schemaSha256: string;
  readonly version: unknown;
}> {
  const entrypoint = fileURLToPath(import.meta.resolve('@modelcontextprotocol/ext-apps'));
  const packageRoot = dirname(dirname(dirname(entrypoint)));
  const parsed: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('installed ext-apps package metadata must be an object');
  }
  const metadata = Object.fromEntries(Object.entries(parsed));
  const schema = await readFile(join(packageRoot, 'dist/src/generated/schema.json'));
  const schemaDocument: unknown = JSON.parse(schema.toString('utf8'));
  if (typeof schemaDocument !== 'object' || schemaDocument === null) {
    throw new Error('installed ext-apps schema must be an object');
  }
  const definitions = Reflect.get(schemaDocument, '$defs');
  if (typeof definitions !== 'object' || definitions === null) {
    throw new Error('installed ext-apps schema must contain definitions');
  }
  const schemaMethods = Object.values(definitions)
    .map((definition) =>
      typeof definition === 'object' && definition !== null
        ? Reflect.get(Reflect.get(definition, 'properties') ?? {}, 'method')
        : undefined
    )
    .map((method) =>
      typeof method === 'object' && method !== null ? Reflect.get(method, 'const') : undefined
    )
    .filter((method): method is string => typeof method === 'string')
    .sort();
  return {
    schemaMethods,
    schemaSha256: createHash('sha256').update(schema).digest('hex'),
    version: metadata['version'],
  };
}

describe('stable MCP Apps client capability', () => {
  it('pins the reviewed stable extension and official schema provenance', async () => {
    const installedMetadata = await readInstalledExtAppsMetadata();
    expect(installedMetadata).toEqual({
      schemaMethods: [...MCP_APPS_PINNED_SCHEMA_UI_METHODS].sort(),
      schemaSha256: 'e9af2289956641a266d99273facb746c2023bae48567d64bb83c63aadecb856f',
      version: '2.0.3',
    });
    expect({
      capability: MCP_APPS_CLIENT_CAPABILITY,
      extensionId: MCP_APPS_EXTENSION_ID,
      mimeType: MCP_APPS_MIME_TYPE,
      source: MCP_APPS_CONTRACT_SOURCE,
      specVersion: MCP_APPS_SPEC_VERSION,
    }).toEqual({
      capability: { mimeTypes: ['text/html;profile=mcp-app'] },
      extensionId: 'io.modelcontextprotocol/ui',
      mimeType: 'text/html;profile=mcp-app',
      source: {
        gitCommit: '82221c0c8ce7661efa6771c9d461511b1650495f',
        package: '@modelcontextprotocol/ext-apps',
        packageVersion: '2.0.3',
        schemaSha256: 'e9af2289956641a266d99273facb746c2023bae48567d64bb83c63aadecb856f',
        specificationUrl:
          'https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/specification/2026-01-26/apps.mdx',
      },
      specVersion: '2026-01-26',
    });
  });

  it('projects the stable specification from the complete pinned schema vocabulary', () => {
    expect(
      MCP_APPS_PINNED_SCHEMA_UI_METHODS.filter(
        (method) => !Object.hasOwn(MCP_APPS_SCHEMA_EXCLUSIONS, method)
      )
    ).toEqual(MCP_APPS_STABLE_UI_METHODS);
  });

  it('accepts only the complete stable MIME declaration', () => {
    expect(parseMcpAppsClientCapability({ mimeTypes: ['text/html;profile=mcp-app'] })).toEqual({
      mimeTypes: ['text/html;profile=mcp-app'],
    });
  });

  it.each([
    undefined,
    null,
    {},
    { mimeTypes: 'text/html;profile=mcp-app' },
    { mimeTypes: [] },
    { mimeTypes: ['text/html'] },
    { mimeTypes: ['text/html;profile=mcp-app', 'text/html'] },
    { features: [], mimeTypes: ['text/html;profile=mcp-app'] },
  ])('rejects malformed, missing, or extra capability settings: %j', (input) => {
    expect(() => parseMcpAppsClientCapability(input)).toThrow(/MCP Apps client capability/);
  });
});
