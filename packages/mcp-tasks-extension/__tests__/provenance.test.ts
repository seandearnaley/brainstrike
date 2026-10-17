import { createHash } from 'node:crypto';
import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  MCP_TASKS_CONTRACT_PROFILE,
  MCP_TASKS_CONTRACT_PROFILE_SHA256,
  MCP_TASKS_REQUEST_METHODS,
  MCP_TASKS_UPSTREAM_SOURCE,
  TaskSchema,
  TaskStatusSchema,
} from '../src/index.js';

describe('MCP Tasks extension provenance', () => {
  it('pins the official ext-tasks 2026-07-28 schema and type artifacts', () => {
    expect(MCP_TASKS_UPSTREAM_SOURCE).toEqual({
      artifacts: {
        schemaJson: {
          path: 'schema/2026-07-28/schema.json',
          sha256: 'bf30afb7ac251e3e22c037b7a685f60ef6603031b5484c0d08b1fa0bbe86d460',
        },
        schemaTypes: {
          path: 'schema/2026-07-28/schema.ts',
          sha256: '35a4ae593e60410716196773b5b63e8cb4677ddb49edc1afb8bbb43753dda4e7',
        },
        specificationJson: {
          path: 'schema/2026-07-28/spec.schema.json',
          sha256: '78f0902444e03fc687f262ce796a48af06c02bc67be3d1bf36b7a2ffbb83d0fa',
        },
        specificationTypes: {
          path: 'schema/2026-07-28/spec.types.ts',
          sha256: 'a34751c63a0858e42764fe74079f4a3dca82e323f0e1d1570510c713f74de8a8',
        },
        tasksDocumentation: {
          path: 'specification/2026-07-28/tasks.md',
          sha256: 'ef2860ae4418d02f3b2bfd54fcd88b03a3c2c3aa6724d282cd4ca3a3699a2e27',
        },
      },
      commitSha: '0d0a6bd4c258b35caa3c810a1dd506cf105b1501',
      repositoryUrl: 'https://github.com/modelcontextprotocol/ext-tasks.git',
    });
  });

  it('pins the reviewed local contract profile', () => {
    expect(MCP_TASKS_CONTRACT_PROFILE_SHA256).toBe(
      '4f295b17fe4cc6b2440e8b2f4298908c54403f34e9b6e338abab4f400081f7a2'
    );
    expect(
      createHash('sha256').update(JSON.stringify(MCP_TASKS_CONTRACT_PROFILE)).digest('hex')
    ).toBe(MCP_TASKS_CONTRACT_PROFILE_SHA256);
  });

  it('keeps the reviewed profile synchronized with executable schemas', () => {
    expect(MCP_TASKS_CONTRACT_PROFILE.task.statuses).toEqual(TaskStatusSchema.literals);
    const baseTask = {
      createdAt: 'date',
      lastUpdatedAt: 'date',
      status: 'working',
      taskId: 'task',
      ttlMs: null,
    };
    const decode = Schema.decodeUnknownResult(TaskSchema);
    expect(Result.isSuccess(decode(baseTask))).toBe(true);
    const required = Object.keys(TaskSchema.schema.fields).filter((field) =>
      Result.isFailure(
        decode(Object.fromEntries(Object.entries(baseTask).filter(([name]) => name !== field)))
      )
    );
    expect(MCP_TASKS_CONTRACT_PROFILE.task.required.toSorted()).toEqual(required.toSorted());
    expect(MCP_TASKS_CONTRACT_PROFILE.requests.map(({ method }) => method)).toEqual(
      MCP_TASKS_REQUEST_METHODS
    );
  });
});
