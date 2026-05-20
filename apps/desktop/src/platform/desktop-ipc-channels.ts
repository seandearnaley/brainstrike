export const DESKTOP_PRELOAD_IPC_CHANNELS = {
  agent: {
    assistantGetUrl: 'assistant:get-url',
    chat: 'agent:chat',
  },
  files: {
    parserHostParse: 'parser-host:parse',
  },
  mcp: {
    configCreateSample: 'mcp:config:createSample',
    configGet: 'mcp:config:get',
    configGetPath: 'mcp:config:getPath',
    configReadText: 'mcp:config:readText',
    configSelectPath: 'mcp:config:selectPath',
    configSetPath: 'mcp:config:setPath',
    configUnwatch: 'mcp:config:unwatch',
    configWatch: 'mcp:config:watch',
    configWriteText: 'mcp:config:writeText',
    toolsDisable: 'mcp:tools:disable',
    toolsDisableServer: 'mcp:tools:disableServer',
    toolsEnable: 'mcp:tools:enable',
    toolsEnableServer: 'mcp:tools:enableServer',
    toolsGetStats: 'mcp:tools:getStats',
    toolsList: 'mcp:tools:list',
    toolsReset: 'mcp:tools:reset',
    toolsUpdated: 'mcp:tools:updated',
  },
  runtime: {
    noteReloadIntent: 'app:lifecycle:note-reload-intent',
  },
  tools: {
    execute: 'tools:execute',
  },
} as const;
