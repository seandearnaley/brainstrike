import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { ThemeSettings } from '@brainstrike/ui';
import {
  Bot,
  BrainCircuit,
  FolderTree,
  Palette,
  Search,
  Settings,
  ShieldCheck,
  Sigma,
  Webhook,
} from 'lucide-react';
import type { TestMemoryEmbedder } from './settings/models/assistant-memory-embedder-test';
import { AssistantMemorySettingsSection } from './settings/models/assistant-memory-settings-section';
import { SubagentSettingsSection } from './settings/models/subagent-settings-section';
import type { ClearContentProps } from './settings/system/clear-content-panel';
import { FactoryResetSettingsSection } from './settings/system/factory-reset-settings-section';
import {
  type HookReviewRoot,
  HooksSettingsSection,
} from './settings/system/hooks-settings-section';
import { PermissionSettingsSection } from './settings/system/permission-settings-section';
import {
  type SavedBrowserOrigins,
  SavedBrowserOriginsSection,
} from './settings/system/saved-browser-origins-section';
import { SearchIndexSettingsSection } from './settings/system/search-index-settings-section';
import {
  SubagentPersonasSettingsSection,
  type SubagentPersonasSettingsSectionProps,
} from './settings/system/subagent-personas-settings-section';
import { TokenCountingSettingsSection } from './settings/system/token-counting-settings-section';
import {
  WorktreeSettingsSection,
  type WorktreeSettingsSectionProps,
} from './settings/system/worktree-settings-section';
import { WorktreeSetupConsentSettingsSection } from './settings/system/worktree-setup-consent-settings-section';
import type { SettingsCategory } from './settings-page-content';

export function createAppearanceSettingsCategory(): SettingsCategory {
  return {
    content: <ThemeSettings />,
    description: 'Choose your theme, fonts and code colours.',
    icon: Palette,
    id: 'appearance',
    keywords: [
      'theme',
      'color',
      'display',
      'dark mode',
      'font',
      'typeface',
      'code theme',
      'syntax',
    ],
    title: 'Appearance',
  };
}

export function createTokenCountingSettingsCategory(): SettingsCategory {
  return createTokenCountingSettingsCategoryWithRuntimeSupport({ accurateRuntimeAvailable: null });
}

export function createTokenCountingSettingsCategoryWithRuntimeSupport({
  accurateRuntimeAvailable,
}: {
  accurateRuntimeAvailable: boolean | null;
}): SettingsCategory {
  return {
    content: <TokenCountingSettingsSection accurateRuntimeAvailable={accurateRuntimeAvailable} />,
    description: 'Control the tokenizer used for Explorer token counts.',
    icon: Sigma,
    id: 'token-counting',
    keywords: ['token', 'counting', 'tiktoken', 'preview'],
    title: 'Token Counting',
  };
}

export interface CreateFactoryResetSettingsCategoryOptions {
  clearContent?: ClearContentProps;
  hasStoredFolders?: boolean;
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  isWebPlatform?: boolean;
  onClearStoredFolders?: () => void;
}

export function createFactoryResetSettingsCategory(
  options?: CreateFactoryResetSettingsCategoryOptions
): SettingsCategory {
  return {
    content: (
      <FactoryResetSettingsSection
        clearContent={options?.clearContent}
        hasStoredFolders={options?.hasStoredFolders}
        inlineFixtureSetting={options?.inlineFixtureSetting}
        isWebPlatform={options?.isWebPlatform}
        onClearStoredFolders={options?.onClearStoredFolders}
      />
    ),
    description: 'Wipe application data and reset preferences.',
    icon: Settings,
    id: 'factory-reset',
    keywords: ['factory', 'reset', 'resetting', 'wipe', 'preferences', 'stored folders'],
    title: 'Factory Reset',
  };
}

export interface CreateWorkspaceSettingsCategoryOptions {
  readonly onSave: WorktreeSettingsSectionProps['onSave'];
  readonly settings: WorktreeSettingsSectionProps['settings'];
  readonly status: WorktreeSettingsSectionProps['status'];
}

export function createWorkspaceSettingsCategory(
  options: CreateWorkspaceSettingsCategoryOptions
): SettingsCategory {
  return {
    content: (
      <div className="space-y-6">
        <WorktreeSettingsSection
          onSave={options.onSave}
          settings={options.settings}
          status={options.status}
        />
        <WorktreeSetupConsentSettingsSection />
      </div>
    ),
    description:
      'Choose where Brainstrike creates managed worktrees, set an optional per-worktree setup command, and review repository setup-script consent.',
    icon: FolderTree,
    id: 'workspace',
    keywords: [
      'worktree',
      'worktrees',
      'managed directory',
      'workspace',
      'git',
      'setup command',
      'consent',
      'revoke',
    ],
    title: 'Workspace',
  };
}

export function createSearchIndexingSettingsCategory(
  nativeIndex?: import('@brainstrike/indexing-contract/indexer-client').IndexSearchCapability
): SettingsCategory {
  return {
    content: <SearchIndexSettingsSection {...(nativeIndex ? { nativeIndex } : {})} />,
    description:
      'Choose how your folders are searched, the embedding model and how files are split.',
    icon: Search,
    id: 'search-indexing',
    keywords: ['search', 'indexing', 'semantic', 'embeddings', 'chunking', 'model'],
    title: 'Search & Indexing',
  };
}

/** `browserOrigins`: the desktop host's saved site answers (BST-1178); web has none. */
export function createPermissionSettingsCategory(options?: {
  readonly browserOrigins?: SavedBrowserOrigins | undefined;
}): SettingsCategory {
  const browserOrigins = options?.browserOrigins;
  return {
    content: browserOrigins ? (
      <div className="space-y-6">
        <PermissionSettingsSection />
        <SavedBrowserOriginsSection origins={browserOrigins} />
      </div>
    ) : (
      <PermissionSettingsSection />
    ),
    description: 'Gate the assistant’s tools behind an allow / ask / deny policy.',
    icon: ShieldCheck,
    id: 'permissions',
    keywords: [
      'permissions',
      'permission',
      'policy',
      'enforce',
      'allow',
      'ask',
      'deny',
      'access',
      'auto',
      'full access',
      'yolo',
      'quick model',
      'tools',
      'safety',
      'guardrails',
      'sites',
      'browser',
    ],
    title: 'Permissions',
  };
}

export interface CreateAssistantMemorySettingsCategoryOptions {
  readonly assistantMemoryBackendAvailable: boolean;
  readonly providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
  /** The host's test of the selected embedder (BST-2227). */
  readonly testEmbedder?: TestMemoryEmbedder;
}

export function createAssistantMemorySettingsCategory({
  assistantMemoryBackendAvailable,
  providerKeySources,
  testEmbedder,
}: CreateAssistantMemorySettingsCategoryOptions): SettingsCategory {
  return {
    content: (
      <AssistantMemorySettingsSection
        assistantMemoryBackendAvailable={assistantMemoryBackendAvailable}
        {...(providerKeySources ? { providerKeySources } : {})}
        {...(testEmbedder ? { testEmbedder } : {})}
      />
    ),
    description: 'Configure the assistant’s observational memory and semantic recall.',
    icon: BrainCircuit,
    id: 'assistant-memory',
    keywords: ['memory', 'observations', 'semantic recall', 'mastra', 'embedding'],
    title: 'Assistant Memory',
  };
}

export function createSubagentPersonasSettingsCategory(
  options: SubagentPersonasSettingsSectionProps = {}
): SettingsCategory {
  return {
    content: (
      <div className="space-y-6">
        <SubagentPersonasSettingsSection {...options} />
        <SubagentSettingsSection />
      </div>
    ),
    description:
      'Control which subagent personas the assistant may delegate to, and the budgets every subagent runs under.',
    icon: Bot,
    id: 'subagents',
    keywords: [
      'subagents',
      'subagent',
      'personas',
      'persona',
      'delegation',
      'delegate',
      'agents',
      'explorer',
      'analyst',
      'budgets',
      'steps',
      'output tokens',
      'summary',
    ],
    title: 'Subagents',
  };
}

export type { HookReviewRoot };

export interface CreateHooksSettingsCategoryOptions {
  readonly globalConfigPath?: string;
  readonly roots?: readonly HookReviewRoot[];
}

export function createHooksSettingsCategory(
  options: CreateHooksSettingsCategoryOptions = {}
): SettingsCategory {
  return {
    content: (
      <HooksSettingsSection
        {...(options.roots ? { roots: options.roots } : {})}
        {...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {})}
      />
    ),
    description: 'Approve a workspace’s shell hooks before they run at tool-lifecycle events.',
    icon: Webhook,
    id: 'hooks',
    keywords: ['hooks', 'shell', 'lifecycle', 'pretooluse', 'posttooluse', 'trust', 'approve'],
    title: 'Hooks',
  };
}
