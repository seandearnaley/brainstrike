import type { PermissionPolicies } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it } from 'vitest';
import { sanitizeAssistantRunEventMetadata } from '../../run-events';
import type { StreamChunk, StreamChunkRunEvent } from '../../types';
import {
  makePermissionGateResolvedChunks,
  type PermissionGateSummary,
  summarizePermissionGate,
} from '../permission-gate-run-events';
import type { PermissionAskToolMetadata } from '../permission-tool-gate';

const POLICIES: PermissionPolicies = { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'ask' };

function summary(overrides: Partial<PermissionGateSummary> = {}): PermissionGateSummary {
  return {
    askTools: [{ riskCategory: 'read', tool: 'brainstrike.readWorkspaceFile' }],
    defaultRisk: 'mcp',
    deniedTools: [{ riskCategory: 'edit', tool: 'brainstrike.writeWorkspaceFile' }],
    grantedCategories: [],
    omittedAskTools: [],
    overrideCount: 0,
    policies: { ...POLICIES },
    yolo: false,
    ...overrides,
  };
}

function runEvent(chunk: StreamChunk | undefined): StreamChunkRunEvent['event'] {
  if (chunk?.type !== 'run-event') {
    throw new Error(`Expected a run-event chunk, got ${String(chunk?.type)}`);
  }
  return chunk.event;
}

describe('summarizePermissionGate', () => {
  it('is null when no policy snapshot gated the run', () => {
    expect(
      summarizePermissionGate({
        deniedTools: new Map(),
        gatedAskTools: new Map(),
        keptAskTools: new Map(),
        snapshot: undefined,
      })
    ).toBeNull();
  });

  it('reads the snapshot and names kept, omitted and denied tools by their original names', () => {
    const read: PermissionAskToolMetadata = {
      originalName: 'brainstrike.readWorkspaceFile',
      riskCategory: 'read',
    };
    const shell: PermissionAskToolMetadata = {
      originalName: 'brainstrike.runShell',
      riskCategory: 'execute',
    };

    expect(
      summarizePermissionGate({
        deniedTools: new Map([
          [
            'brainstrike_writeWorkspaceFile',
            { originalName: 'brainstrike.writeWorkspaceFile', riskCategory: 'edit' },
          ],
        ]),
        gatedAskTools: new Map([
          ['brainstrike_readWorkspaceFile', read],
          ['brainstrike_runShell', shell],
        ]),
        keptAskTools: new Map([['brainstrike_readWorkspaceFile', read]]),
        snapshot: {
          perToolOverrides: { 'brainstrike.grepSearch': 'allow' },
          policies: { ...POLICIES },
          sessionGrants: ['mcp'],
          yolo: false,
        },
      })
    ).toEqual({
      askTools: [{ riskCategory: 'read', tool: 'brainstrike.readWorkspaceFile' }],
      defaultRisk: null,
      deniedTools: [{ riskCategory: 'edit', tool: 'brainstrike.writeWorkspaceFile' }],
      grantedCategories: ['mcp'],
      omittedAskTools: [{ riskCategory: 'execute', tool: 'brainstrike.runShell' }],
      overrideCount: 1,
      policies: POLICIES,
      yolo: false,
    });
  });
});

describe('makePermissionGateResolvedChunks', () => {
  it('mints nothing when no policy gated the run', () => {
    expect(makePermissionGateResolvedChunks(null)).toEqual([]);
  });

  it('mints ONE completed row carrying the resolved gate', () => {
    const chunks = makePermissionGateResolvedChunks(summary());

    expect(chunks).toHaveLength(1);
    const event = runEvent(chunks[0]);
    expect(event).toMatchObject({
      detail: '1 tool gated to ask (read: 1); 1 denied; session grants: none',
      kind: 'permission.gate.resolved',
      label: 'Permission gate resolved',
      status: 'completed',
    });
    expect(event.metadata).toEqual({
      askTools: [{ riskCategory: 'read', tool: 'brainstrike.readWorkspaceFile' }],
      defaultRisk: 'mcp',
      deniedTools: [{ riskCategory: 'edit', tool: 'brainstrike.writeWorkspaceFile' }],
      grantedCategories: [],
      omittedAskTools: [],
      overrideCount: 0,
      policies: POLICIES,
      yolo: false,
    });
  });

  it('names storage-less omissions and session grants in the detail', () => {
    const event = runEvent(
      makePermissionGateResolvedChunks(
        summary({
          askTools: [],
          deniedTools: [],
          grantedCategories: ['read', 'mcp'],
          omittedAskTools: [{ riskCategory: 'execute', tool: 'brainstrike.runShell' }],
        })
      )[0]
    );

    expect(event.detail).toBe(
      '0 tools gated to ask; 0 denied; 1 ask tool omitted without approval storage; session grants: read, mcp'
    );
  });

  it('survives the run-event persistence sanitizer with every field intact', () => {
    // The desktop writer and the history repository both run this sanitizer;
    // it drops any key containing `session`, so a `sessionGrants` key would
    // reach the pack as nothing at all.
    const event = runEvent(
      makePermissionGateResolvedChunks(
        summary({
          grantedCategories: ['read'],
          omittedAskTools: [{ riskCategory: 'execute', tool: 'brainstrike.runShell' }],
        })
      )[0]
    );

    expect(sanitizeAssistantRunEventMetadata(event.metadata)).toEqual(event.metadata);
  });
});
