import { cn, Input, ThemeSettings } from '@brainstrike/ui';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight, Palette, Search, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

const SETTINGS_HASH_PREFIX = 'settings/';

export interface SettingsCategory {
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
  icon?: LucideIcon;
  render: () => ReactNode;
}

export interface SettingsPageContentProps {
  categories: SettingsCategory[];
  defaultCategoryId?: string;
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

  useEffect(() => {
    if (!categories.length) {
      setActiveCategoryId(null);
      return;
    }

    const exists = categories.some((category) => category.id === activeCategoryId);

    if (!exists) {
      setActiveCategoryId(selectInitialCategory(categories, defaultCategoryId));
    }
  }, [categories, defaultCategoryId, activeCategoryId]);

  useEffect(() => {
    if (!filteredCategories.length) {
      return;
    }

    const currentExists = filteredCategories.some((category) => category.id === activeCategoryId);
    if (!currentExists) {
      setActiveCategoryId(filteredCategories[0]?.id ?? null);
    }
  }, [filteredCategories, activeCategoryId]);

  useEffect(() => {
    if (!activeCategoryId) {
      return;
    }
    updateHash(activeCategoryId);
  }, [activeCategoryId]);

  const activeCategory = filteredCategories.find((category) => category.id === activeCategoryId);

  return (
    <div className="h-full overflow-hidden">
      <div className="flex h-full flex-col">
        <header className="px-8 pt-8 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Settings className="h-6 w-6 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Customize application behavior, integrations, and appearance.
              </p>
            </div>
          </div>
          <div className="mt-6 relative">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              role="searchbox"
              aria-label="Search settings"
              className="pl-9 pr-3 py-2"
            />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <nav
            aria-label="Settings categories"
            className="w-80 shrink-0 border-r border-border overflow-y-auto px-4 py-6 space-y-1"
          >
            {filteredCategories.length ? (
              filteredCategories.map((category) => {
                const Icon = category.icon;
                const isActive = category.id === activeCategoryId;

                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setActiveCategoryId(category.id)}
                    className={cn(
                      'w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors border border-transparent',
                      isActive
                        ? 'bg-primary/10 border-primary/40 text-primary'
                        : 'hover:bg-muted/60'
                    )}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {Icon ? (
                      <Icon className="h-4 w-4 flex-none text-primary" aria-hidden="true" />
                    ) : (
                      <span
                        className="h-2 w-2 rounded-full bg-muted-foreground/60"
                        aria-hidden="true"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium leading-tight truncate">{category.title}</div>
                      {category.description ? (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {category.description}
                        </p>
                      ) : null}
                    </div>
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 flex-none transition-transform',
                        isActive ? 'translate-x-0' : '-translate-x-0.5 text-muted-foreground'
                      )}
                      aria-hidden="true"
                    />
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-4 text-sm text-muted-foreground rounded-md border border-dashed border-border/60 bg-muted/40">
                No settings matched "{query}".
              </div>
            )}
          </nav>

          <section className="flex-1 overflow-y-auto px-8 py-6">
            {filteredCategories.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Try adjusting your search to find settings.
              </div>
            ) : activeCategory ? (
              <div className="space-y-6" data-testid={`settings-category-${activeCategory.id}`}>
                <div>
                  <h2 className="text-2xl font-semibold">{activeCategory.title}</h2>
                  {activeCategory.description ? (
                    <p className="text-sm text-muted-foreground mt-1">
                      {activeCategory.description}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-6">{activeCategory.render()}</div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
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
    render: () => <ThemeSettings />,
  };
}
