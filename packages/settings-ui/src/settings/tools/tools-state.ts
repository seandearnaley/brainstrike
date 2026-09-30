import type { ToolCategory, ToolLoadingTier } from '@brainstrike/assistant-contract/tool-metadata';
import type { McpConfigInfo, McpServerInfo, ToolDisplayMetadata } from './types';

function areToolsEqual(
  nextTools: ToolDisplayMetadata[],
  previousTools: ToolDisplayMetadata[]
): boolean {
  if (nextTools.length !== previousTools.length) {
    return false;
  }
  for (let index = 0; index < nextTools.length; index += 1) {
    const nextTool = nextTools[index];
    const previousTool = previousTools[index];
    if (!(nextTool && previousTool)) {
      return false;
    }
    if (
      nextTool.id !== previousTool.id ||
      nextTool.source !== previousTool.source ||
      nextTool.category !== previousTool.category ||
      nextTool.loadingTier !== previousTool.loadingTier ||
      nextTool.description !== previousTool.description ||
      nextTool.enabled !== previousTool.enabled ||
      nextTool.estimatedTokens !== previousTool.estimatedTokens ||
      nextTool.requiresApproval !== previousTool.requiresApproval ||
      nextTool.serverName !== previousTool.serverName
    ) {
      return false;
    }
  }
  return true;
}

interface ToolsDataState {
  error: string | null;
  errorBoundaryKey: number;
  errorSource: string | null;
  loadError: string | null;
  loading: boolean;
  mcpConfigInfo: McpConfigInfo | null;
  mcpError: string | null;
  mcpRevision: number;
  mcpServers: McpServerInfo[];
  preferencesError: string | null;
  tools: ToolDisplayMetadata[];
}

export type ToolsDataAction =
  | { type: 'SET_TOOLS'; tools: ToolDisplayMetadata[] }
  | { type: 'APPLY_MCP_STATUS'; revision: number; servers: readonly McpServerInfo[] }
  | { type: 'SET_MCP_CONFIG_INFO'; info: McpConfigInfo | null }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string; source: string; preferencesFault?: string | null }
  | { type: 'CLEAR_OPERATION_ERROR'; source: string }
  | { type: 'SET_LOAD_ERROR' | 'SET_MCP_ERROR' | 'SET_PREFERENCES_ERROR'; error: string | null }
  | { type: 'RESET'; loading: boolean }
  | { type: 'INCREMENT_BOUNDARY_KEY' };

export const initialToolsDataState: ToolsDataState = {
  error: null,
  errorBoundaryKey: 0,
  errorSource: null,
  loadError: null,
  loading: true,
  mcpConfigInfo: null,
  mcpError: null,
  mcpRevision: -1,
  mcpServers: [],
  preferencesError: null,
  tools: [],
};

export function toolsDataReducer(state: ToolsDataState, action: ToolsDataAction): ToolsDataState {
  switch (action.type) {
    case 'SET_TOOLS':
      return {
        ...state,
        tools: areToolsEqual(action.tools, state.tools) ? state.tools : action.tools,
      };
    case 'APPLY_MCP_STATUS':
      // Desktop's singleton publisher never resets revision on config replacement.
      return action.revision > state.mcpRevision
        ? { ...state, mcpRevision: action.revision, mcpServers: [...action.servers] }
        : state;
    case 'SET_MCP_CONFIG_INFO':
      return { ...state, mcpConfigInfo: action.info };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SET_ERROR':
      // A refusal may arrive after its exact pre-action fault was recovered.
      if (
        action.preferencesFault === action.error &&
        state.preferencesError !== action.preferencesFault
      ) {
        return state;
      }
      return { ...state, error: action.error, errorSource: action.source };
    case 'CLEAR_OPERATION_ERROR':
      // A successful retry owns only the failure from that exact action.
      return state.errorSource === action.source
        ? { ...state, error: null, errorSource: null }
        : state;
    case 'SET_LOAD_ERROR':
      return { ...state, loadError: action.error };
    case 'SET_MCP_ERROR':
      return { ...state, mcpError: action.error };
    case 'SET_PREFERENCES_ERROR': {
      // A refused toggle can duplicate the current fault. Recovery owns that
      // exact message too, but never an unrelated or merely similar failure.
      const recoveredOperation =
        action.error === null &&
        state.preferencesError !== null &&
        state.error === state.preferencesError;
      return {
        ...state,
        error: recoveredOperation ? null : state.error,
        errorSource: recoveredOperation ? null : state.errorSource,
        preferencesError: action.error,
      };
    }
    case 'RESET':
      // Error-boundary retries reset view/loading, not the accepted host authority.
      return {
        ...initialToolsDataState,
        errorBoundaryKey: state.errorBoundaryKey,
        loading: action.loading,
        mcpConfigInfo: state.mcpConfigInfo,
        mcpRevision: state.mcpRevision,
        mcpServers: state.mcpServers,
      };
    case 'INCREMENT_BOUNDARY_KEY':
      return { ...state, errorBoundaryKey: state.errorBoundaryKey + 1 };
    default:
      return state;
  }
}

interface ToolsUiState {
  activeTab: 'tools' | 'mcp-config';
  categoryFilter: ToolCategory | 'all';
  configAlertDismissed: boolean;
  expandedToolId: string | null;
  searchQuery: string;
  tierFilter: ToolLoadingTier | 'all';
}

type ToolsUiAction =
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'SET_CATEGORY_FILTER'; category: ToolCategory | 'all' }
  | { type: 'SET_TIER_FILTER'; tier: ToolLoadingTier | 'all' }
  | { type: 'SET_EXPANDED_TOOL_ID'; toolId: string | null }
  | { type: 'SET_CONFIG_ALERT_DISMISSED' }
  | { type: 'SET_ACTIVE_TAB'; tab: 'tools' | 'mcp-config' }
  | { type: 'RESET_FILTERS' };

export const initialToolsUiState: ToolsUiState = {
  activeTab: 'tools',
  categoryFilter: 'all',
  configAlertDismissed: false,
  expandedToolId: null,
  searchQuery: '',
  tierFilter: 'all',
};

export function toolsUiReducer(state: ToolsUiState, action: ToolsUiAction): ToolsUiState {
  switch (action.type) {
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.query };
    case 'SET_CATEGORY_FILTER':
      return { ...state, categoryFilter: action.category };
    case 'SET_TIER_FILTER':
      return { ...state, tierFilter: action.tier };
    case 'SET_EXPANDED_TOOL_ID':
      return { ...state, expandedToolId: action.toolId };
    case 'SET_CONFIG_ALERT_DISMISSED':
      return { ...state, configAlertDismissed: true };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab };
    case 'RESET_FILTERS':
      return { ...state, categoryFilter: 'all', searchQuery: '', tierFilter: 'all' };
    default:
      return state;
  }
}
