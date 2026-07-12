import { cn, Input, ThemeSettings } from '@brainstrike/ui';
import type { LucideIcon } from 'lucide-react';
import { Cpu, Key, Palette, Search, Settings, ShieldCheck, Sigma, Webhook } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ModelSelectionPage } from './settings/models/model-selection-page';
import { LocalRuntimeSettingsSection } from './settings/runtimes/local-runtime-settings-section';
import { ApiKeysSettings } from './settings/secrets/api-keys-settings';
import { SettingsSearchIcon } from './settings/settings-search-icon';
import { SETTINGS_SEARCH_INPUT_STYLE } from './settings/settings-search-layout';
import { FactoryResetSettingsSection } from './settings/system/factory-reset-settings-section';
import {
  type HookReviewRoot,
  HooksSettingsSection,
} from './settings/system/hooks-settings-section';
import { PermissionSettingsSection } from './settings/system/permission-settings-section';
import { SearchIndexingSettingsSection } from './settings/system/search-indexing-settings-section';
import { TokenCountingSettingsSection } from './settings/system/token-counting-settings-section';

/**
 * Hash prefix for settings navigation.
 * URLs follow the pattern: #settings/{categoryId}
 * Example: #settings/appearance, #settings/desktop-preferences
 */
const SETTINGS_HASH_PREFIX = 'settings/';

/**
 * Represents a settings category that can be rendered in the settings page.
 *
 * Categories appear in the left navigation panel and their content is displayed
 * in the main content area when selected. Each category can be searched by its
 * title, description, and keywords.
 *
 * @example
 * ```tsx
 * const category: SettingsCategory = {
 *   id: 'appearance',
 *   title: 'Appearance',
 *   description: 'Customize the look and feel of the application',
 *   keywords: ['theme', 'color', 'dark mode', 'display'],
 *   icon: Palette,
 *   content: <ThemeSettings />,
 * };
 * ```
 */
export interface SettingsCategory {
  /**
   * React content displayed when the category is active.
   * Note: the ReactNode is created eagerly, but only mounted when selected.
   */
  content: ReactNode;
  /**
   * Optional subtitle displayed below the title in both navigation and content area.
   * Use this to clarify the purpose or scope of the category.
   */
  description?: string;

  /**
   * Optional Lucide icon component displayed in the navigation panel.
   * Improves visual hierarchy and category recognition.
   * If omitted, a small dot indicator is shown instead.
   */
  icon?: LucideIcon;
  /**
   * Unique identifier for the category.
   * Used in URL hash routing (e.g., #settings/appearance).
   * Must be URL-safe (use kebab-case, no spaces or special characters).
   */
  id: string;

  /**
   * Optional search terms that aren't displayed to users but improve discoverability.
   * Include synonyms, related terms, or common misspellings.
   * Searches are case-insensitive and use substring matching.
   */
  keywords?: string[];

  /**
   * Display name shown in the navigation panel and content header.
   * Should be concise and descriptive (2-3 words recommended).
   */
  title: string;
}

/**
 * Props for the SettingsPageContent component.
 */
export interface SettingsPageContentProps {
  /**
   * Array of settings categories to display in the navigation panel.
   * Order determines the display order in navigation.
   */
  categories: SettingsCategory[];

  /**
   * Optional ID of the category to show by default when no hash is present.
   * If not specified, the first category in the array is used.
   * Overridden by URL hash if present.
   */
  defaultCategoryId?: string;

  /**
   * Optional placeholder text for the search input.
   * @default 'Search settings…'
   */
  searchPlaceholder?: string;
}

const isClient = typeof window !== 'undefined';

function getCategoryIdFromHash(hash: string) {
  if (!hash.startsWith(`#${SETTINGS_HASH_PREFIX}`)) {
    return null;
  }

  const [, categoryId = ''] = hash.split('#');
  const [, id = ''] = categoryId.split(SETTINGS_HASH_PREFIX);
  return id || null;
}

function updateHash(categoryId: string) {
  if (!isClient) {
    return;
  }

  const targetHash = `#${SETTINGS_HASH_PREFIX}${categoryId}`;
  if (window.location.hash === targetHash) {
    return;
  }

  const url = new URL(window.location.href);
  url.hash = `${SETTINGS_HASH_PREFIX}${categoryId}`;
  window.history.replaceState(null, '', url);
}

function selectInitialCategory(
  categories: SettingsCategory[],
  defaultCategoryId?: string
): string | null {
  if (!categories.length) {
    return null;
  }

  if (isClient) {
    const hashCategory = getCategoryIdFromHash(window.location.hash);
    if (hashCategory && categories.some((category) => category.id === hashCategory)) {
      return hashCategory;
    }
  }

  if (defaultCategoryId && categories.some((category) => category.id === defaultCategoryId)) {
    return defaultCategoryId;
  }

  return categories[0]?.id ?? null;
}

/**
 * Shared settings page layout.
 *
 * Note: The actual settings categories are composed by the consuming application (Desktop or Web).
 * Be careful when adding new categories here to ensure they are compatible with both platforms,
 * or use the `categories` prop to inject platform-specific settings.
 */
export function SettingsPageContent({
  categories,
  defaultCategoryId,
  searchPlaceholder = 'Search settings…',
}: SettingsPageContentProps) {
  const [query, setQuery] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState(() =>
    selectInitialCategory(categories, defaultCategoryId)
  );

  const normalizedQuery = query.trim().toLowerCase();

  const filteredCategories = useMemo(() => {
    if (!normalizedQuery) {
      return categories;
    }

    return categories.filter((category) => {
      const haystack = [category.title, category.description ?? '', ...(category.keywords ?? [])]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [categories, normalizedQuery]);

  useEffect(() => {
    if (!isClient) {
      return;
    }

    const handleHashChange = () => {
      const hashCategory = getCategoryIdFromHash(window.location.hash);
      if (!hashCategory) {
        return;
      }

      const exists = categories.some((category) => category.id === hashCategory);
      if (exists) {
        setActiveCategoryId(hashCategory);
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [categories]);

  // Derive the effective active category — no effects needed for state correction
  const effectiveActiveCategoryId = useMemo(() => {
    if (!categories.length) {
      return null;
    }
    if (
      activeCategoryId &&
      categories.some((category) => category.id === activeCategoryId) &&
      filteredCategories.some((category) => category.id === activeCategoryId)
    ) {
      return activeCategoryId;
    }
    if (filteredCategories.length > 0) {
      return filteredCategories[0]?.id ?? null;
    }
    return selectInitialCategory(categories, defaultCategoryId);
  }, [categories, defaultCategoryId, filteredCategories, activeCategoryId]);

  // Sync hash when effective category changes, but not on every render
  const prevEffectiveCategoryRef = useRef<string | null>(null);
  if (prevEffectiveCategoryRef.current !== effectiveActiveCategoryId) {
    prevEffectiveCategoryRef.current = effectiveActiveCategoryId;
    if (effectiveActiveCategoryId) {
      updateHash(effectiveActiveCategoryId);
    }
  }

  const activeCategory = filteredCategories.find(
    (category) => category.id === effectiveActiveCategoryId
  );

  return (
    <div
      className="grid h-full min-h-0 overflow-hidden"
      style={{ gridTemplateColumns: '248px minmax(0, 1fr)' }}
    >
      <nav
        aria-label="Settings categories"
        className="flex min-h-0 flex-col border-border/70 border-r bg-muted/20"
      >
        <div className="border-border/60 border-b px-4 pt-4 pb-3">
          <div className="flex items-center gap-2 px-1">
            <Settings aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="font-medium text-sm">Settings</span>
          </div>
          <div className="relative mt-3">
            <SettingsSearchIcon />
            <Input
              aria-label="Search settings"
              className="h-9 rounded-lg border-border/70 bg-background/75 pr-3 pl-10 shadow-none"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              role="searchbox"
              style={SETTINGS_SEARCH_INPUT_STYLE}
              value={query}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
          {filteredCategories.length ? (
            filteredCategories.map((category) => {
              const Icon = category.icon;
              const isActive = category.id === effectiveActiveCategoryId;

              return (
                <button
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'group flex min-h-9 w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm transition-[background-color,border-color,color] duration-150',
                    isActive
                      ? 'border-border/70 bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                  )}
                  key={category.id}
                  onClick={() => setActiveCategoryId(category.id)}
                  type="button"
                >
                  {Icon ? (
                    <Icon
                      aria-hidden="true"
                      className={cn(
                        'size-4 flex-none transition-colors',
                        isActive
                          ? 'text-primary'
                          : 'text-muted-foreground group-hover:text-foreground'
                      )}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-muted-foreground/60"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium leading-tight">
                    {category.title}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="rounded-lg border border-border/60 border-dashed bg-background/50 px-3 py-4 text-muted-foreground text-sm">
              No settings matched "{query}".
            </div>
          )}
        </div>
      </nav>

      <section className="min-h-0 overflow-y-auto px-8 lg:px-10" style={{ paddingBlock: '2rem' }}>
        {filteredCategories.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Try adjusting your search to find settings.
          </div>
        ) : activeCategory ? (
          <div
            className="mx-auto max-w-3xl space-y-7"
            data-testid={`settings-category-${activeCategory.id}`}
          >
            <div className="border-border/60 border-b pr-10 pb-5">
              <h2 className="font-semibold text-xl tracking-tight">{activeCategory.title}</h2>
              {activeCategory.description ? (
                <p className="mt-1.5 max-w-2xl text-muted-foreground text-sm leading-relaxed">
                  {activeCategory.description}
                </p>
              ) : null}
            </div>
            <div className="space-y-6">{activeCategory.content}</div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Select a setting category to view its options.
          </div>
        )}
      </section>
    </div>
  );
}

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

/**
 * Options for creating the Factory Reset settings category.
 */
export interface CreateFactoryResetSettingsCategoryOptions {
  /** Whether stored folders exist */
  hasStoredFolders?: boolean;
  /** Inline fixture settings (developer feature) */
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  /** Whether running on web platform. Defaults to true. */
  isWebPlatform?: boolean;
  /** Callback to clear stored folders */
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

export function createModelRegistrySettingsCategory(): SettingsCategory {
  return {
    content: <ModelSelectionPage />,
    description: 'Choose chat and embedding models, manage downloads, and configure providers.',
    icon: Settings, // Using Settings icon for now, could import something better like Brain or Cpu
    id: 'models',
    keywords: [
      'models',
      'providers',
      'llm',
      'embedding',
      'openai',
      'anthropic',
      'google',
      'download',
    ],
    title: 'Models & Providers',
  };
}

export function createApiKeysSettingsCategory(): SettingsCategory {
  return {
    content: <ApiKeysSettings />,
    description: 'Manage API keys for external LLM providers.',
    icon: Key,
    id: 'api-keys',
    keywords: ['api', 'keys', 'secrets', 'credentials', 'openai', 'anthropic', 'google'],
    title: 'API Keys',
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
