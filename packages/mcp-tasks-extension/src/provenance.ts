const artifact = (path: string, sha256: string) => Object.freeze({ path, sha256 });

export const MCP_TASKS_UPSTREAM_SOURCE = Object.freeze({
  artifacts: Object.freeze({
    schemaJson: artifact(
      'schema/2026-07-28/schema.json',
      'bf30afb7ac251e3e22c037b7a685f60ef6603031b5484c0d08b1fa0bbe86d460'
    ),
    schemaTypes: artifact(
      'schema/2026-07-28/schema.ts',
      '35a4ae593e60410716196773b5b63e8cb4677ddb49edc1afb8bbb43753dda4e7'
    ),
    specificationJson: artifact(
      'schema/2026-07-28/spec.schema.json',
      '78f0902444e03fc687f262ce796a48af06c02bc67be3d1bf36b7a2ffbb83d0fa'
    ),
    specificationTypes: artifact(
      'schema/2026-07-28/spec.types.ts',
      'a34751c63a0858e42764fe74079f4a3dca82e323f0e1d1570510c713f74de8a8'
    ),
    tasksDocumentation: artifact(
      'specification/2026-07-28/tasks.md',
      'ef2860ae4418d02f3b2bfd54fcd88b03a3c2c3aa6724d282cd4ca3a3699a2e27'
    ),
  }),
  commitSha: '0d0a6bd4c258b35caa3c810a1dd506cf105b1501',
  repositoryUrl: 'https://github.com/modelcontextprotocol/ext-tasks.git',
});

export const MCP_TASKS_CONTRACT_PROFILE = Object.freeze({
  createTaskResultType: 'task',
  extensionId: 'io.modelcontextprotocol/tasks',
  notifications: Object.freeze(['notifications/tasks']),
  requests: Object.freeze([
    Object.freeze({
      method: 'tasks/get',
      params: Object.freeze(['taskId']),
      resultType: 'complete',
    }),
    Object.freeze({
      method: 'tasks/update',
      params: Object.freeze(['taskId', 'inputResponses']),
      resultType: 'complete',
    }),
    Object.freeze({
      method: 'tasks/cancel',
      params: Object.freeze(['taskId']),
      resultType: 'complete',
    }),
  ]),
  settings: Object.freeze({}),
  subscriptionAdditions: Object.freeze({
    acknowledgedNotifications: Object.freeze({ taskIds: 'string[]?' }),
    notifications: Object.freeze({ taskIds: 'string[]?' }),
  }),
  task: Object.freeze({
    required: Object.freeze(['taskId', 'status', 'createdAt', 'lastUpdatedAt', 'ttlMs']),
    statuses: Object.freeze(['working', 'input_required', 'completed', 'failed', 'cancelled']),
    statusRequirements: Object.freeze({
      cancelled: Object.freeze([]),
      completed: Object.freeze(['result']),
      failed: Object.freeze(['error']),
      // biome-ignore lint/style/useNamingConvention: canonical MCP wire status.
      input_required: Object.freeze(['inputRequests']),
      working: Object.freeze([]),
    }),
  }),
  version: '2026-07-28',
});

export const MCP_TASKS_CONTRACT_PROFILE_SHA256 =
  '4f295b17fe4cc6b2440e8b2f4298908c54403f34e9b6e338abab4f400081f7a2' as const;
