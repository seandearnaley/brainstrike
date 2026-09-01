import { MCP_SUPPORT_MATRIX } from '@brainstrike/assistant-contract';
import type { McpServerInfo } from './types';

type ConnectedCatalog = NonNullable<Extract<McpServerInfo, { state: 'connected' }>['catalog']>;
const CATALOG_PREVIEW_LIMIT = 5;

interface CatalogPreviewItem {
  key: string;
  text: string;
}

function displayTitle(title: string | undefined, fallback: string): string {
  const normalized = title?.trim();
  return normalized ? normalized : fallback;
}

function CatalogPreview({ items, label }: { items: readonly CatalogPreviewItem[]; label: string }) {
  if (items.length === 0) {
    return null;
  }
  const visible = items.slice(0, CATALOG_PREVIEW_LIMIT);
  return (
    <div className="space-y-0.5 text-xs">
      <div className="font-medium">
        {label} (showing {visible.length} of {items.length})
      </div>
      {visible.map((item) => (
        <div className="break-all text-muted-foreground" key={item.key}>
          {item.text}
        </div>
      ))}
    </div>
  );
}

export function McpServerCatalog({
  catalog,
  serverId,
}: {
  catalog: ConnectedCatalog;
  serverId: string;
}) {
  const featureRows = [
    ['Resources', catalog.features.resources],
    ['Prompts', catalog.features.prompts],
    ['Completion', catalog.features.completion],
    ['Resource subscriptions', catalog.features.resourceSubscriptions],
    ['Resource list changes', catalog.features.resourceListChanged],
    ['Prompt list changes', catalog.features.promptListChanged],
    ['Tool list changes', catalog.features.toolListChanged],
  ] as const;
  const resources = (catalog.resources?.resources ?? []).map((resource) => ({
    key: resource.uri,
    text: `${displayTitle(resource.title, resource.name)} · ${resource.uri}`,
  }));
  const templates = (catalog.resourceTemplates?.resourceTemplates ?? []).map((template) => ({
    key: template.uriTemplate,
    text: `${displayTitle(template.title, template.name)} · ${template.uriTemplate}`,
  }));
  const prompts = (catalog.prompts?.prompts ?? []).map((prompt) => ({
    key: prompt.name,
    text: displayTitle(prompt.title, prompt.name),
  }));
  const tools = (catalog.tools?.tools ?? []).map((tool) => ({
    key: tool.name,
    text: displayTitle(tool.title, tool.name),
  }));
  const honoredFilter = catalog.subscription.honoredFilter;
  const honoredResources = honoredFilter?.resourceSubscriptions ?? [];
  const errors = [
    ['Resources', catalog.errors.resources],
    ['Resource templates', catalog.errors.resourceTemplates],
    ['Prompts', catalog.errors.prompts],
    ['Tools', catalog.errors.tools],
    ['Subscription', catalog.errors.subscription],
  ] as const;

  return (
    <div className="mt-2 space-y-2 border-t pt-2" data-testid={`mcp-server-catalog-${serverId}`}>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {featureRows.map(([label, supported]) => (
          <span className="text-muted-foreground" key={label}>
            {label}{' '}
            <span className={supported ? 'text-emerald-700 dark:text-emerald-300' : ''}>
              {supported ? 'Supported' : 'Unsupported'}
            </span>
          </span>
        ))}
      </div>
      <div className="text-muted-foreground text-xs">
        delivery {catalog.subscription.mode} · {catalog.subscription.state}
      </div>
      {honoredFilter && (
        <div className="text-muted-foreground text-xs">
          honored filters · prompts {honoredFilter.promptsListChanged === true ? 'yes' : 'no'} ·
          resources {honoredFilter.resourcesListChanged === true ? 'yes' : 'no'} · tools{' '}
          {honoredFilter.toolsListChanged === true ? 'yes' : 'no'} · resource subscriptions{' '}
          {honoredResources.length}
        </div>
      )}
      <CatalogPreview items={resources} label="Resources" />
      <CatalogPreview items={templates} label="Resource templates" />
      <CatalogPreview items={prompts} label="Prompts" />
      <CatalogPreview items={tools} label="Tools" />
      <CatalogPreview
        items={honoredResources.map((uri) => ({ key: uri, text: uri }))}
        label="Honored resource subscriptions"
      />
      {errors.map(([label, error]) =>
        error ? (
          <div className="text-destructive text-xs" key={label}>
            {label}: {error.category} · {error.code} · {error.message}
          </div>
        ) : null
      )}
    </div>
  );
}

export function McpSupportMatrix() {
  return (
    <section
      aria-labelledby="mcp-support-title"
      className="space-y-2"
      data-testid="mcp-support-matrix"
    >
      <div>
        <h3 className="font-medium text-sm" id="mcp-support-title">
          MCP protocol support
        </h3>
        <p className="text-muted-foreground text-xs">
          Core support and optional extensions are independent capabilities.
        </p>
      </div>
      <div className="space-y-2">
        {MCP_SUPPORT_MATRIX.map((entry) => (
          <div
            className="rounded-md border px-3 py-2 text-sm"
            data-implementation-ticket={entry.implementationTicket ?? ''}
            data-status={entry.status}
            data-testid={`mcp-support-row-${entry.id}`}
            key={entry.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{entry.label}</span>
              <span
                className={
                  entry.status === 'supported'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-muted-foreground'
                }
                data-testid={`mcp-support-status-${entry.id}`}
              >
                {entry.status === 'supported' ? 'Supported' : 'Unsupported'}
              </span>
            </div>
            <div className="break-all font-mono text-muted-foreground text-xs">{entry.id}</div>
            <p className="text-muted-foreground text-xs">{entry.evidence}</p>
            {'requirements' in entry && (
              <p className="text-muted-foreground text-xs">
                Graduation gates: {entry.requirements.join(', ')}.
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
