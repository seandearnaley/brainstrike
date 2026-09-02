export const MCP_APPS_PINNED_SCHEMA_UI_METHODS = Object.freeze([
  'ui/initialize',
  'ui/notifications/initialized',
  'ui/open-link',
  'ui/message',
  'ui/request-display-mode',
  'ui/update-model-context',
  'ui/notifications/size-changed',
  'ui/resource-teardown',
  'ui/notifications/tool-input',
  'ui/notifications/tool-input-partial',
  'ui/notifications/tool-result',
  'ui/notifications/tool-cancelled',
  'ui/notifications/host-context-changed',
  'ui/notifications/sandbox-proxy-ready',
  'ui/notifications/sandbox-resource-ready',
  'ui/download-file',
  'ui/notifications/request-teardown',
] as const);

export const MCP_APPS_SCHEMA_EXCLUSIONS = Object.freeze({
  'ui/download-file': 'absent from the stable 2026-01-26 specification',
  'ui/notifications/request-teardown': 'absent from the stable 2026-01-26 specification',
} as const);

type McpAppStableUiMethod = Exclude<
  (typeof MCP_APPS_PINNED_SCHEMA_UI_METHODS)[number],
  keyof typeof MCP_APPS_SCHEMA_EXCLUSIONS
>;

export const MCP_APPS_STABLE_UI_METHODS = Object.freeze(
  MCP_APPS_PINNED_SCHEMA_UI_METHODS.filter(
    (method) => !Object.hasOwn(MCP_APPS_SCHEMA_EXCLUSIONS, method)
  ) as readonly McpAppStableUiMethod[]
);

export const MCP_APPS_STABLE_STANDARD_METHODS = Object.freeze([
  'tools/call',
  'resources/read',
  'notifications/message',
  'ping',
] as const);

export const MCP_APPS_STABLE_METHODS = Object.freeze([
  ...MCP_APPS_STABLE_UI_METHODS,
  ...MCP_APPS_STABLE_STANDARD_METHODS,
]);

export type McpAppStableMethod = (typeof MCP_APPS_STABLE_METHODS)[number];
