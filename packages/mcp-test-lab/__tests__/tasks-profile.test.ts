import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  getMcpLabScenario,
  MCP_LAB_SDK_SOURCE_SHA,
  MCP_LAB_TASKS_PROFILE_SOURCE,
} from '../src/scenario';
import { TASKS_PROFILE, TASKS_PROFILE_SHA256 } from '../src/tasks-profile';

describe('MCP Tasks reference profile', () => {
  it('is a frozen, digest-bound behaviour profile of the 2026-07-28 Tasks revision', () => {
    expect(Object.isFrozen(TASKS_PROFILE)).toBe(true);
    expect(Object.isFrozen(TASKS_PROFILE.timeline)).toBe(true);
    expect(TASKS_PROFILE.spec).toBe('2026-07-28');
    expect(TASKS_PROFILE.extensionId).toBe('io.modelcontextprotocol/tasks');
    expect(TASKS_PROFILE.capabilities.extensions).toEqual({ 'io.modelcontextprotocol/tasks': {} });
    expect(TASKS_PROFILE.timeline).toEqual(['working', 'input_required', 'completed']);
    expect(TASKS_PROFILE_SHA256).toBe(
      createHash('sha256').update(JSON.stringify(TASKS_PROFILE)).digest('hex')
    );
    expect(TASKS_PROFILE_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('binds the scenario to the profile digest with partial pinned-SDK provenance', () => {
    const scenario = getMcpLabScenario('tasks-reference');
    expect(scenario.fixture).toBe('brainstrike-tasks-reference');
    expect(scenario.fixtureSource).toEqual(MCP_LAB_TASKS_PROFILE_SOURCE);
    expect(MCP_LAB_TASKS_PROFILE_SOURCE).toEqual({
      kind: 'brainstrike-owned-derived-profile',
      path: 'packages/mcp-test-lab/src/tasks-profile.ts',
      sha256: TASKS_PROFILE_SHA256,
      upstream: {
        commitSha: MCP_LAB_SDK_SOURCE_SHA,
        kind: 'official-typescript-sdk',
        path: 'packages/core/src/schemas.ts',
        repositoryUrl: expect.stringContaining('typescript-sdk'),
        sha256: '4d6cd50c55b1ee4f747f3a0fdd2b423d23f64c95fc5eb2afb4a197c9761d82e4',
      },
    });
    expect(scenario.protocol).toEqual({ era: 'modern', version: '2026-07-28' });
    expect(scenario.transport).toBe('streamable-http');
    expect(scenario.usesAmbientCredentials).toBe(false);
  });
});

describe('MCP Tasks reference server construction', () => {
  it('refuses the single-request constructor so the task store always outlives a request', async () => {
    const { createReferenceServer, createReferenceServerFactory } = await import(
      '../src/reference-server'
    );
    expect(() => createReferenceServer('brainstrike-tasks-reference')).toThrow(
      /createReferenceServerFactory/u
    );
    expect(typeof createReferenceServerFactory('brainstrike-tasks-reference')).toBe('function');
  });
});
