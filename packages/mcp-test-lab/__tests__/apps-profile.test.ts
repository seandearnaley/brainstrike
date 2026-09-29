import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APPS_PROFILE, APPS_PROFILE_SHA256 } from '../src/apps-profile';
import { getMcpLabScenario, MCP_LAB_APPS_PROFILE_SOURCE } from '../src/scenario';

describe('MCP Apps reference profile', () => {
  it('is a frozen, digest-bound derived profile of the pinned example server', () => {
    expect(Object.isFrozen(APPS_PROFILE)).toBe(true);
    expect(APPS_PROFILE.resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(APPS_PROFILE.tool.meta).toEqual({
      ui: { resourceUri: APPS_PROFILE.resource.uri },
      'ui/resourceUri': APPS_PROFILE.resource.uri,
    });
    expect(APPS_PROFILE.document.length).toBe(1065);
    expect(createHash('sha256').update(APPS_PROFILE.document).digest('hex')).toBe(
      APPS_PROFILE.upstream.files['mcp-app.html']
    );
    expect(APPS_PROFILE_SHA256).toBe(
      createHash('sha256').update(JSON.stringify(APPS_PROFILE)).digest('hex')
    );
  });

  it('binds the scenario to the profile digest with ext-apps provenance', () => {
    const scenario = getMcpLabScenario('apps-reference');
    expect(scenario.fixture).toBe('brainstrike-apps-reference');
    expect(scenario.fixtureSource).toEqual(MCP_LAB_APPS_PROFILE_SOURCE);
    expect(MCP_LAB_APPS_PROFILE_SOURCE).toEqual({
      kind: 'brainstrike-owned-derived-profile',
      path: 'packages/mcp-test-lab/src/apps-profile.ts',
      sha256: APPS_PROFILE_SHA256,
      upstream: {
        commitSha: '92f46a574568a3ddac7600343b7d3c4c4ed7b588',
        kind: 'official-ext-apps',
        path: 'examples/basic-server-vanillajs/server.ts',
        repositoryUrl: 'https://github.com/modelcontextprotocol/ext-apps.git',
        sha256: APPS_PROFILE.upstream.files['server.ts'],
      },
    });
    expect(scenario.protocol).toEqual({ era: 'modern', version: '2026-07-28' });
    expect(scenario.usesAmbientCredentials).toBe(false);
  });
});
