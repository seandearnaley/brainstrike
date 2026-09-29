import { cn, Input } from '@brainstrike/ui';
import type { LucideIcon } from 'lucide-react';
import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { SettingsSearchIcon } from './settings/settings-search-icon';
import { SETTINGS_SEARCH_INPUT_STYLE } from './settings/settings-search-layout';

/**
 * Hash prefix for settings navigation.
 * URLs follow the pattern: #settings/{categoryId}
 * Example: #settings/appearance, #settings/desktop-preferences
 */
const SETTINGS_HASH_PREFIX = 'settings/';

/**
 * `document` (default): a centred `max-w-3xl` column; the page scrolls.
 * `workspace`: full width and height; the category owns its own scrolling
 * (BST-1805 — the Model Catalog's single scroll owner).
 */
export type SettingsCategoryLayout = 'document' | 'workspace';

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
  /** Optional controls rendered at the right of the category title (e.g. Refresh). */
  headerActions?: ReactNode;

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
  /** How the category's content is laid out; defaults to `document`. */
  layout?: SettingsCategoryLayout;

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

function updateHash(categoryId: string | null) {
  if (!(isClient && categoryId)) {
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

  // Browser history is an external system. Synchronize it only after React
  // commits so an interrupted or discarded render cannot leak a URL mutation.
  useEffect(() => {
    updateHash(effectiveActiveCategoryId);
  }, [effectiveActiveCategoryId]);

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
            <h1 className="font-medium text-sm">Settings</h1>
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

      <section
        className={cn(
          'min-h-0 px-8 lg:px-10',
          activeCategory?.layout === 'workspace'
            ? 'flex flex-col overflow-hidden'
            : 'overflow-y-auto'
        )}
        style={{ paddingBlock: '2rem' }}
      >
        {filteredCategories.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Try adjusting your search to find settings.
          </div>
        ) : activeCategory ? (
          <div
            className={
              activeCategory.layout === 'workspace'
                ? 'flex min-h-0 w-full flex-1 flex-col gap-5'
                : 'mx-auto max-w-3xl space-y-7'
            }
            data-layout={activeCategory.layout ?? 'document'}
            data-testid={`settings-category-${activeCategory.id}`}
          >
            <div
              className="flex shrink-0 items-start justify-between gap-4 border-border/60 border-b pb-5"
              data-testid={`settings-category-header-${activeCategory.id}`}
            >
              <div className="min-w-0">
                <h2 className="font-semibold text-xl tracking-tight">{activeCategory.title}</h2>
                {activeCategory.description ? (
                  <p className="mt-1.5 max-w-2xl text-muted-foreground text-sm leading-relaxed">
                    {activeCategory.description}
                  </p>
                ) : null}
              </div>
              {activeCategory.headerActions ? (
                <div className="flex shrink-0 items-center gap-2">
                  {activeCategory.headerActions}
                </div>
              ) : null}
            </div>
            <div
              className={
                activeCategory.layout === 'workspace' ? 'flex min-h-0 flex-1 flex-col' : 'space-y-6'
              }
            >
              {activeCategory.content}
            </div>
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
