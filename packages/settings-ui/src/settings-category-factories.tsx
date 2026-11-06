import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { ThemeSettings } from '@brainstrike/ui';
import {
  Bot,
  BrainCircuit,
  FolderTree,
  Palette,
  Settings,
  ShieldCheck,
  Sigma,
  Webhook,
} from 'lucide-react';
import { AssistantMemorySettingsSection } from './settings/models/assistant-memory-settings-section';
import { SubagentModelsSection } from './settings/models/subagent-models-section';
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
    description: 'Choose your theme, fonts and code colors.',
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
      'interface font',
      'code font',
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
    description: 'Choose how Explorer counts tokens.',
    icon: Sigma,
    id: 'token-counting',
    keywords: [
      'token',
      'counting',
      'tiktoken',
      'preview',
      'accurate token counts',
      'estimated counts',
      'tokenizer',
      'wasm',
    ],
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
    keywords: [
      'factory',
      'reset',
      'resetting',
      'wipe',
      'preferences',
      'stored folders',
      'clear content',
      'delete chats',
      'forget all folders',
      'inline fixtures',
    ],
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
      'managed worktree location',
      'default location',
      'disable setup',
      'setup script',
    ],
    title: 'Workspace',
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
      'enforce tool permissions',
      'tool policy',
      'tool category policies',
      'per-tool overrides',
      'session grants',
      'access mode',
      'auto-review model',
      'sites the agent may open',
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
    description: 'Configure the assistant’s observational memory.',
    icon: BrainCircuit,
    id: 'assistant-memory',
    keywords: [
      'memory',
      'observations',
      'mastra',
      'observational memory',
      'enable observations',
      'observation scope',
      'observe messages after',
      'reflect observations after',
      'retrieval mode',
    ],
    title: 'Assistant Memory',
  };
}

export function createSubagentPersonasSettingsCategory({
  configuredProviders,
  providersError,
  ...options
}: SubagentPersonasSettingsSectionProps & {
  /** The providers the host can run; absent while unknown. */
  readonly configuredProviders?: readonly string[] | undefined;
  readonly providersError?: string | undefined;
} = {}): SettingsCategory {
  return {
    content: (
      <div className="space-y-6">
        <SubagentPersonasSettingsSection {...options} />
        <SubagentModelsSection
          configuredProviders={configuredProviders}
          providersError={providersError}
        />
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
      'models',
      'agents',
      'explorer',
      'analyst',
      'budgets',
      'steps',
      'output tokens',
      'summary',
      'enable subagent delegation',
      'subagent limits',
      'delegation depth',
      'subagents per turn',
      'subagent work at once',
      'steps per subagent',
      'runtime per subagent',
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
    keywords: [
      'hooks',
      'shell',
      'lifecycle',
      'pretooluse',
      'posttooluse',
      'trust',
      'approve',
      'workspace hooks',
      'hooks.json',
      'revoke',
    ],
    title: 'Hooks',
  };
}
