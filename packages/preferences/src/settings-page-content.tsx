import { cn, Input, ThemeSettings } from '@brainstrike/ui';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronRight,
  Cpu,
  Key,
  Palette,
  Search,
  Settings,
  ShieldCheck,
  Sigma,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ModelSelectionPage } from './settings/models/model-selection-page';
import { LocalRuntimeSettingsSection } from './settings/runtimes/local-runtime-settings-section';
import { ApiKeysSettings } from './settings/secrets/api-keys-settings';
import { FactoryResetSettingsSection } from './settings/system/factory-reset-settings-section';
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
    <div className="h-full overflow-hidden">
      <div className="flex h-full flex-col">
        <header className="border-border border-b px-8 pt-8 pb-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Settings aria-hidden="true" className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="font-semibold text-3xl tracking-tight">Settings</h1>
              <p className="text-muted-foreground text-sm">
                Customize application behavior, integrations, and appearance.
              </p>
            </div>
          </div>
          <div className="relative mt-6">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search settings"
              className="py-2 pr-3 pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              role="searchbox"
              value={query}
            />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <nav
            aria-label="Settings categories"
            className="w-80 shrink-0 space-y-1 overflow-y-auto border-border border-r px-4 py-6"
          >
            {filteredCategories.length ? (
              filteredCategories.map((category) => {
                const Icon = category.icon;
                const isActive = category.id === effectiveActiveCategoryId;

                return (
                  <button
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-colors',
                      isActive
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'hover:bg-muted/60'
                    )}
                    key={category.id}
                    onClick={() => setActiveCategoryId(category.id)}
                    type="button"
                  >
                    {Icon ? (
                      <Icon aria-hidden="true" className="h-4 w-4 flex-none text-primary" />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-full bg-muted-foreground/60"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium leading-tight">{category.title}</div>
                      {category.description ? (
                        <p className="line-clamp-2 text-muted-foreground text-xs">
                          {category.description}
                        </p>
                      ) : null}
                    </div>
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        'h-4 w-4 flex-none transition-transform',
                        isActive ? 'translate-x-0' : '-translate-x-0.5 text-muted-foreground'
                      )}
                    />
                  </button>
                );
              })
            ) : (
              <div className="rounded-md border border-border/60 border-dashed bg-muted/40 px-3 py-4 text-muted-foreground text-sm">
                No settings matched "{query}".
              </div>
            )}
          </nav>

          <section className="flex-1 overflow-y-auto px-8 py-6">
            {filteredCategories.length === 0 ? (
              <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                Try adjusting your search to find settings.
              </div>
            ) : activeCategory ? (
              <div className="space-y-6" data-testid={`settings-category-${activeCategory.id}`}>
                <div>
                  <h2 className="font-semibold text-2xl">{activeCategory.title}</h2>
                  {activeCategory.description ? (
                    <p className="mt-1 text-muted-foreground text-sm">
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
      </div>
    </div>
  );
}

export function createAppearanceSettingsCategory(): SettingsCategory {
  return {
    id: 'appearance',
    title: 'Appearance',
    description: 'Choose your theme and personalize the interface for your workflow.',
    keywords: ['theme', 'color', 'display', 'dark mode'],
    icon: Palette,
    content: <ThemeSettings />,
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
    id: 'token-counting',
    title: 'Token Counting',
    description: 'Control the tokenizer used for previews and chunk generation.',
    keywords: ['token', 'counting', 'tiktoken', 'preview', 'chunking'],
    icon: Sigma,
    content: <TokenCountingSettingsSection accurateRuntimeAvailable={accurateRuntimeAvailable} />,
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
    id: 'factory-reset',
    title: 'Factory Reset',
    description: 'Wipe application data and reset preferences.',
    keywords: ['factory', 'reset', 'resetting', 'wipe', 'preferences', 'stored folders'],
    icon: Settings,
    content: (
      <FactoryResetSettingsSection
        hasStoredFolders={options?.hasStoredFolders}
        inlineFixtureSetting={options?.inlineFixtureSetting}
        isWebPlatform={options?.isWebPlatform}
        onClearStoredFolders={options?.onClearStoredFolders}
      />
    ),
  };
}

export function createModelRegistrySettingsCategory(): SettingsCategory {
  return {
    id: 'models',
    title: 'Models & Providers',
    description: 'Choose chat and embedding models, manage downloads, and configure providers.',
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
    icon: Settings, // Using Settings icon for now, could import something better like Brain or Cpu
    content: <ModelSelectionPage />,
  };
}

export function createApiKeysSettingsCategory(): SettingsCategory {
  return {
    id: 'api-keys',
    title: 'API Keys',
    description: 'Manage API keys for external LLM providers.',
    keywords: ['api', 'keys', 'secrets', 'credentials', 'openai', 'anthropic', 'google'],
    icon: Key,
    content: <ApiKeysSettings />,
  };
}

export function createSearchIndexingSettingsCategory(): SettingsCategory {
  return {
    id: 'search-indexing',
    title: 'Search & Indexing',
    description: 'Choose the managed cache collection and control root-folder background indexing.',
    keywords: ['search', 'indexing', 'background', 'cache', 'collection', 'embeddings'],
    icon: Search,
    content: <SearchIndexingSettingsSection />,
  };
}

export function createPermissionSettingsCategory(): SettingsCategory {
  return {
    id: 'permissions',
    title: 'Permissions',
    description: 'Gate the assistant’s tools behind an allow / ask / deny policy.',
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
    icon: ShieldCheck,
    content: <PermissionSettingsSection />,
  };
}

export function createLocalRuntimeSettingsCategory(): SettingsCategory {
  return {
    id: 'local-runtimes',
    title: 'Local Runtimes',
    description:
      'Detect and configure local LLM servers (Ollama, LM Studio) for chat and embeddings.',
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
    icon: Cpu,
    content: <LocalRuntimeSettingsSection />,
  };
}
