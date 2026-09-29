import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { ThemeSettings } from '@brainstrike/ui';
import {
  Bot,
  BrainCircuit,
  Cpu,
  FolderTree,
  Palette,
  Search,
  Settings,
  ShieldCheck,
  Sigma,
  Webhook,
} from 'lucide-react';
import { AssistantMemorySettingsSection } from './settings/models/assistant-memory-settings-section';
import { SubagentSettingsSection } from './settings/models/subagent-settings-section';
import { LocalRuntimeSettingsSection } from './settings/runtimes/local-runtime-settings-section';
import { FactoryResetSettingsSection } from './settings/system/factory-reset-settings-section';
import {
  type HookReviewRoot,
  HooksSettingsSection,
} from './settings/system/hooks-settings-section';
import { PermissionSettingsSection } from './settings/system/permission-settings-section';
import { SearchIndexingSettingsSection } from './settings/system/search-indexing-settings-section';
import { SubagentPersonasSettingsSection } from './settings/system/subagent-personas-settings-section';
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
    description: 'Choose your theme and personalize the interface for your workflow.',
    icon: Palette,
    id: 'appearance',
    keywords: ['theme', 'color', 'display', 'dark mode'],
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
    description: 'Control the tokenizer used for previews and chunk generation.',
    icon: Sigma,
    id: 'token-counting',
    keywords: ['token', 'counting', 'tiktoken', 'preview', 'chunking'],
    title: 'Token Counting',
  };
}

export interface CreateFactoryResetSettingsCategoryOptions {
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
      'Choose where BrainStrike creates managed worktrees, set an optional per-worktree setup command, and review repository setup-script consent.',
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

export function createSearchIndexingSettingsCategory(): SettingsCategory {
  return {
    content: <SearchIndexingSettingsSection />,
    description: 'Choose the managed cache collection and control root-folder background indexing.',
    icon: Search,
    id: 'search-indexing',
    keywords: ['search', 'indexing', 'background', 'cache', 'collection', 'embeddings'],
    title: 'Search & Indexing',
  };
}

export function createPermissionSettingsCategory(): SettingsCategory {
  return {
    content: <PermissionSettingsSection />,
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
      'yolo',
      'tools',
      'safety',
      'guardrails',
    ],
    title: 'Permissions',
  };
}

export interface CreateAssistantMemorySettingsCategoryOptions {
  readonly assistantMemoryBackendAvailable: boolean;
  readonly providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
}

export function createAssistantMemorySettingsCategory({
  assistantMemoryBackendAvailable,
  providerKeySources,
}: CreateAssistantMemorySettingsCategoryOptions): SettingsCategory {
  return {
    content: (
      <AssistantMemorySettingsSection
        assistantMemoryBackendAvailable={assistantMemoryBackendAvailable}
        {...(providerKeySources ? { providerKeySources } : {})}
      />
    ),
    description: 'Configure the assistant’s observational memory and semantic recall.',
    icon: BrainCircuit,
    id: 'assistant-memory',
    keywords: ['memory', 'observations', 'semantic recall', 'mastra', 'embedding'],
    title: 'Assistant Memory',
  };
}

export function createSubagentPersonasSettingsCategory(): SettingsCategory {
  return {
    content: (
      <div className="space-y-6">
        <SubagentPersonasSettingsSection />
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

export function createLocalRuntimeSettingsCategory(): SettingsCategory {
  return {
    content: <LocalRuntimeSettingsSection />,
    description:
      'Detect and configure local LLM servers (Ollama, LM Studio) for chat and embeddings.',
    icon: Cpu,
    id: 'local-runtimes',
    keywords: [
      'ollama',
      'lm studio',
      'lmstudio',
      'local',
      'runtime',
      'localhost',
      'gpu',
      'self-hosted',
    ],
    title: 'Local Runtimes',
  };
}
