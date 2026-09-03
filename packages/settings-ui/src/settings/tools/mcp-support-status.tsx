import {
  type ConfiguredMcpServerId,
  MCP_EXTENSION_ID_BY_KEY,
  MCP_EXTENSION_KEYS,
  MCP_SUPPORT_MATRIX,
  type McpExtensionEnablement,
  type McpExtensionKey,
} from '@brainstrike/assistant-contract';
import { Button, Input, Label } from '@brainstrike/ui';
import { useEffect, useRef, useState } from 'react';
import type {
  McpCompleteRequest,
  McpCompleteResult,
  McpContentAuthority,
  McpGetPromptRequest,
  McpGetPromptResult,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpServerInfo,
} from './types';

type ConnectedCatalog = NonNullable<Extract<McpServerInfo, { state: 'connected' }>['catalog']>;
type CatalogPrompt = NonNullable<ConnectedCatalog['prompts']>['prompts'][number];
type PromptMessageContent = McpGetPromptResult['result']['messages'][number]['content'];
const CATALOG_PREVIEW_LIMIT = 5;
/** Bound for any single text body rendered from user-initiated content browsing. */
const CONTENT_TEXT_LIMIT = 2000;
/** Bound for resource contents, prompt messages, and completion values rendered per view. */
const CONTENT_ITEM_LIMIT = 20;
/** Keystrokes collapse into one `completion/complete` round trip per pause. */
const COMPLETION_DEBOUNCE_MS = 250;
const CONTENT_FAILURE_FALLBACK = 'MCP content request failed';

/**
 * User-initiated content browsing (BST-1585). Each action is present only
 * when the platform exposes it; web omits all three, so no affordance renders.
 */
export interface McpServerCatalogContentActions {
  readonly onComplete?: ((request: McpCompleteRequest) => Promise<McpCompleteResult>) | undefined;
  readonly onGetPrompt?:
    | ((request: McpGetPromptRequest) => Promise<McpGetPromptResult>)
    | undefined;
  readonly onReadResource?:
    | ((request: McpReadResourceRequest) => Promise<McpReadResourceResult>)
    | undefined;
}

interface CatalogPreviewAction {
  ariaLabel: string;
  disabled: boolean;
  label: string;
  onClick: () => void;
  pending: boolean;
  testId: string;
}
interface CatalogPreviewItem {
  action?: CatalogPreviewAction;
  key: string;
  text: string;
}
type ContentView =
  | { kind: 'prompt'; name: string; result: McpGetPromptResult['result'] }
  | { kind: 'resource'; result: McpReadResourceResult['result']; uri: string };
interface PromptDraft {
  prompt: CatalogPrompt;
  values: Record<string, string>;
}
interface ArgumentSuggestions {
  argument: string;
  values: readonly string[];
}

function displayTitle(title: string | undefined, fallback: string): string {
  const normalized = title?.trim();
  return normalized ? normalized : fallback;
}

function truncateText(text: string): string {
  if (text.length <= CONTENT_TEXT_LIMIT) {
    return text;
  }
  return `${text.slice(0, CONTENT_TEXT_LIMIT)}… (truncated ${text.length - CONTENT_TEXT_LIMIT} characters)`;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : CONTENT_FAILURE_FALLBACK;
}

function promptArguments(prompt: CatalogPrompt): NonNullable<CatalogPrompt['arguments']> {
  return prompt.arguments ?? [];
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5" key={item.key}>
          <span className="break-all text-muted-foreground">{item.text}</span>
          {item.action && (
            <Button
              aria-busy={item.action.pending}
              aria-label={item.action.ariaLabel}
              className="h-6 px-2 text-xs"
              data-testid={item.action.testId}
              disabled={item.action.disabled}
              onClick={item.action.onClick}
              size="sm"
              type="button"
              variant="ghost"
            >
              {item.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Content items carry no identity beyond their position; derive stable keys
 * from the item identity plus its occurrence count for duplicates.
 */
function withStableKeys<Item>(
  items: readonly Item[],
  identity: (item: Item) => string
): readonly { item: Item; key: string }[] {
  const seen = new Map<string, number>();
  return items.slice(0, CONTENT_ITEM_LIMIT).map((item) => {
    const id = identity(item);
    const occurrence = seen.get(id) ?? 0;
    seen.set(id, occurrence + 1);
    return { item, key: occurrence === 0 ? id : `${id}#${occurrence}` };
  });
}

function BoundedItemsNote({ label, total }: { label: string; total: number }) {
  if (total <= CONTENT_ITEM_LIMIT) {
    return null;
  }
  return (
    <div className="text-muted-foreground">
      {label} (showing {CONTENT_ITEM_LIMIT} of {total})
    </div>
  );
}

function uniqueSuggestionValues(values: readonly string[]): readonly string[] {
  return [...new Set(values)].slice(0, CONTENT_ITEM_LIMIT);
}

function ResourceContents({ result }: { result: McpReadResourceResult['result'] }) {
  return (
    <>
      <BoundedItemsNote label="Contents" total={result.contents.length} />
      {withStableKeys(result.contents, (content) => content.uri).map(({ item, key }) => (
        <div className="space-y-0.5" key={key}>
          <div className="break-all text-muted-foreground">
            {item.uri}
            {typeof item.mimeType === 'string' ? ` · ${item.mimeType}` : ''}
          </div>
          {'text' in item && typeof item.text === 'string' ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
              {truncateText(item.text)}
            </pre>
          ) : (
            <div className="text-muted-foreground italic">
              binary content omitted
              {'blob' in item && typeof item.blob === 'string'
                ? ` (${item.blob.length} base64 characters)`
                : ''}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function PromptMessageBody({ content }: { content: PromptMessageContent }) {
  if (content.type === 'text') {
    return (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
        {truncateText(content.text)}
      </pre>
    );
  }
  return <div className="text-muted-foreground italic">{content.type} content omitted</div>;
}

function PromptContents({ name, result }: { name: string; result: McpGetPromptResult['result'] }) {
  return (
    <>
      {typeof result.description === 'string' && result.description.trim() !== '' && (
        <div className="text-muted-foreground">{result.description}</div>
      )}
      <BoundedItemsNote label="Messages" total={result.messages.length} />
      {withStableKeys(result.messages, (message) => `${name}:${message.role}`).map(
        ({ item, key }) => (
          <div className="space-y-0.5" key={key}>
            <div className="font-medium">{item.role}</div>
            <PromptMessageBody content={item.content} />
          </div>
        )
      )}
    </>
  );
}

function ContentViewPanel({ content, serverId }: { content: ContentView; serverId: string }) {
  return (
    <div
      className="space-y-1 rounded-md border px-2 py-1.5 text-xs"
      data-testid={`mcp-catalog-content-${serverId}`}
    >
      <div className="break-all font-medium">
        {content.kind === 'resource' ? `Resource ${content.uri}` : `Prompt ${content.name}`}
      </div>
      {content.kind === 'resource' ? (
        <ResourceContents result={content.result} />
      ) : (
        <PromptContents name={content.name} result={content.result} />
      )}
    </div>
  );
}

export function McpServerCatalog({
  catalog,
  generation,
  onComplete,
  onGetPrompt,
  onReadResource,
  serverId,
}: McpServerCatalogContentActions & {
  catalog: ConnectedCatalog;
  generation: number;
  serverId: ConfiguredMcpServerId;
}) {
  const authority: McpContentAuthority = { configuredServerId: serverId, generation };
  const pendingRef = useRef<object | null>(null);
  const completionSequenceRef = useRef(0);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [content, setContent] = useState<ContentView | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState<PromptDraft | null>(null);
  const [suggestions, setSuggestions] = useState<ArgumentSuggestions | null>(null);
  const busy = pendingKey !== null;
  // Completion is gated on the server's advertised capability, not just on
  // platform presence: a server without it would fail every keystroke.
  const completionAvailable = onComplete !== undefined && catalog.features.completion;
  const cancelPendingCompletion = (): void => {
    completionSequenceRef.current += 1;
    if (completionTimerRef.current !== null) {
      clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
  };
  useEffect(() => cancelPendingCompletion, []);

  const runContent = async (key: string, operation: () => Promise<ContentView>): Promise<void> => {
    if (pendingRef.current !== null) {
      return;
    }
    const invocation = {};
    pendingRef.current = invocation;
    setPendingKey(key);
    setContentError(null);
    try {
      const view = await operation();
      if (pendingRef.current === invocation) {
        setContent(view);
      }
    } catch (cause) {
      if (pendingRef.current === invocation) {
        setContent(null);
        setContentError(failureMessage(cause));
      }
    } finally {
      if (pendingRef.current === invocation) {
        pendingRef.current = null;
        setPendingKey(null);
      }
    }
  };
  const readResource = (uri: string): void => {
    if (!onReadResource) {
      return;
    }
    void runContent(`resource:${uri}`, async () => ({
      kind: 'resource',
      result: (await onReadResource({ authority, uri })).result,
      uri,
    }));
  };
  const getPrompt = (name: string, values: Record<string, string> | undefined): void => {
    if (!onGetPrompt) {
      return;
    }
    void runContent(`prompt:${name}`, async () => ({
      kind: 'prompt',
      name,
      result: (await onGetPrompt({ ...(values && { arguments: values }), authority, name })).result,
    }));
  };
  const beginPromptDraft = (prompt: CatalogPrompt): void => {
    if (promptArguments(prompt).length === 0) {
      setPromptDraft(null);
      getPrompt(prompt.name, undefined);
      return;
    }
    cancelPendingCompletion();
    setSuggestions(null);
    setCompletionError(null);
    setContentError(null);
    setFormError(null);
    setPromptDraft({ prompt, values: {} });
  };
  const requestSuggestions = (
    prompt: CatalogPrompt,
    argumentName: string,
    value: string,
    values: Record<string, string>
  ): void => {
    cancelPendingCompletion();
    if (!(completionAvailable && onComplete) || value === '') {
      setSuggestions(null);
      return;
    }
    const sequence = completionSequenceRef.current;
    const resolved = Object.fromEntries(
      Object.entries(values).filter(([name, argument]) => name !== argumentName && argument !== '')
    );
    completionTimerRef.current = setTimeout(() => {
      completionTimerRef.current = null;
      void onComplete({
        argument: { name: argumentName, value },
        authority,
        ...(Object.keys(resolved).length > 0 && { context: { arguments: resolved } }),
        ref: { name: prompt.name, type: 'ref/prompt' },
      }).then(
        (response) => {
          if (sequence === completionSequenceRef.current) {
            setCompletionError(null);
            setSuggestions({
              argument: argumentName,
              values: uniqueSuggestionValues(response.result.completion.values),
            });
          }
        },
        (cause: unknown) => {
          if (sequence === completionSequenceRef.current) {
            setSuggestions(null);
            setCompletionError(failureMessage(cause));
          }
        }
      );
    }, COMPLETION_DEBOUNCE_MS);
  };
  const submitPromptDraft = (draft: PromptDraft): void => {
    const missing = promptArguments(draft.prompt).find(
      (argument) => argument.required === true && (draft.values[argument.name] ?? '') === ''
    );
    if (missing) {
      setFormError(`Prompt argument ${missing.name} is required`);
      return;
    }
    setFormError(null);
    const values = Object.fromEntries(
      Object.entries(draft.values).filter(([, argument]) => argument !== '')
    );
    getPrompt(draft.prompt.name, Object.keys(values).length > 0 ? values : undefined);
  };

  const featureRows = [
    ['Resources', catalog.features.resources],
    ['Prompts', catalog.features.prompts],
    ['Completion', catalog.features.completion],
    ['Resource subscriptions', catalog.features.resourceSubscriptions],
    ['Resource list changes', catalog.features.resourceListChanged],
    ['Prompt list changes', catalog.features.promptListChanged],
    ['Tool list changes', catalog.features.toolListChanged],
  ] as const;
  const resources = (catalog.resources?.resources ?? []).map((resource, index) => {
    const name = displayTitle(resource.title, resource.name);
    return {
      ...(onReadResource && {
        action: {
          ariaLabel: `Read ${name}`,
          disabled: busy,
          label: 'Read',
          onClick: () => readResource(resource.uri),
          pending: pendingKey === `resource:${resource.uri}`,
          testId: `mcp-catalog-read-${serverId}-${index}`,
        },
      }),
      key: resource.uri,
      text: `${name} · ${resource.uri}`,
    };
  });
  const templates = (catalog.resourceTemplates?.resourceTemplates ?? []).map((template) => ({
    key: template.uriTemplate,
    text: `${displayTitle(template.title, template.name)} · ${template.uriTemplate}`,
  }));
  const prompts = (catalog.prompts?.prompts ?? []).map((prompt, index) => {
    const name = displayTitle(prompt.title, prompt.name);
    return {
      ...(onGetPrompt && {
        action: {
          ariaLabel: `Use prompt ${name}`,
          disabled: busy,
          label: 'Use prompt',
          onClick: () => beginPromptDraft(prompt),
          pending: pendingKey === `prompt:${prompt.name}`,
          testId: `mcp-catalog-prompt-${serverId}-${index}`,
        },
      }),
      key: prompt.name,
      text: name,
    };
  });
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
      {promptDraft && (
        <form
          aria-busy={pendingKey === `prompt:${promptDraft.prompt.name}`}
          className="space-y-2 rounded-md border px-2 py-1.5 text-xs"
          data-testid={`mcp-catalog-prompt-form-${serverId}`}
          onSubmit={(event) => {
            event.preventDefault();
            submitPromptDraft(promptDraft);
          }}
        >
          <div className="font-medium">
            Prompt {displayTitle(promptDraft.prompt.title, promptDraft.prompt.name)} arguments
          </div>
          {promptArguments(promptDraft.prompt).map((argument) => {
            const inputId = `mcp-catalog-${serverId}-${promptDraft.prompt.name}-${argument.name}`;
            const listId = `${inputId}-options`;
            const hasSuggestions = suggestions?.argument === argument.name;
            return (
              <div className="space-y-1" key={argument.name}>
                <Label className="text-xs" htmlFor={inputId}>
                  {argument.name}
                  {argument.required === true ? ' (required)' : ''}
                </Label>
                <Input
                  autoComplete="off"
                  className="h-8 text-xs"
                  id={inputId}
                  list={hasSuggestions ? listId : undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    const values = { ...promptDraft.values, [argument.name]: value };
                    setFormError(null);
                    setPromptDraft({ prompt: promptDraft.prompt, values });
                    requestSuggestions(promptDraft.prompt, argument.name, value, values);
                  }}
                  required={argument.required === true}
                  value={promptDraft.values[argument.name] ?? ''}
                />
                {hasSuggestions && (
                  <datalist id={listId}>
                    {suggestions.values.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                )}
                {typeof argument.description === 'string' && argument.description.trim() !== '' && (
                  <p className="text-muted-foreground">{argument.description}</p>
                )}
              </div>
            );
          })}
          {completionError && (
            <div className="text-destructive">Argument autocomplete failed: {completionError}</div>
          )}
          {formError && (
            <div className="text-destructive" role="alert">
              {formError}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              aria-label={`Get prompt ${displayTitle(promptDraft.prompt.title, promptDraft.prompt.name)}`}
              className="h-7 px-2 text-xs"
              disabled={busy}
              size="sm"
              type="submit"
              variant="outline"
            >
              Get prompt
            </Button>
            <Button
              className="h-7 px-2 text-xs"
              disabled={busy}
              onClick={() => {
                cancelPendingCompletion();
                setPromptDraft(null);
                setSuggestions(null);
                setCompletionError(null);
                setContentError(null);
                setFormError(null);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {contentError && (
        <div className="text-destructive text-xs" role="alert">
          MCP content request failed: {contentError}
        </div>
      )}
      {content && <ContentViewPanel content={content} serverId={serverId} />}
    </div>
  );
}

const SUPPORT_STATUS_LABELS = {
  disabled: 'Disabled',
  supported: 'Supported',
  unsupported: 'Unsupported',
} as const satisfies Record<'disabled' | (typeof MCP_SUPPORT_MATRIX)[number]['status'], string>;

/** Reverse of `MCP_EXTENSION_ID_BY_KEY`, so a matrix row can find its dial. */
const EXTENSION_KEY_BY_ID: Readonly<Record<string, McpExtensionKey>> = Object.freeze(
  Object.fromEntries(MCP_EXTENSION_KEYS.map((key) => [MCP_EXTENSION_ID_BY_KEY[key], key]))
);

/**
 * The matrix reports compiled-in product support. When the caller supplies the
 * global registered-extension dials (BST-1604), an extension the user turned off
 * reports `Disabled` instead — the row would otherwise claim a capability the
 * next connection will not advertise. Absent the prop, behaviour is unchanged.
 */
export function McpSupportMatrix({
  extensionPreferences,
}: {
  readonly extensionPreferences?: McpExtensionEnablement | undefined;
}) {
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
        {MCP_SUPPORT_MATRIX.map((entry) => {
          const extensionKey = EXTENSION_KEY_BY_ID[entry.id];
          const turnedOff =
            extensionKey !== undefined &&
            extensionPreferences !== undefined &&
            !extensionPreferences[extensionKey];
          const status = turnedOff ? 'disabled' : entry.status;
          return (
            <div
              className="rounded-md border px-3 py-2 text-sm"
              data-implementation-ticket={entry.implementationTicket ?? ''}
              data-status={status}
              data-testid={`mcp-support-row-${entry.id}`}
              key={entry.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{entry.label}</span>
                <span
                  className={
                    status === 'supported'
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-muted-foreground'
                  }
                  data-testid={`mcp-support-status-${entry.id}`}
                >
                  {SUPPORT_STATUS_LABELS[status]}
                </span>
              </div>
              <div className="break-all font-mono text-muted-foreground text-xs">{entry.id}</div>
              {turnedOff && (
                <p className="text-muted-foreground text-xs">
                  Turned off in settings — not advertised on new connections.
                </p>
              )}
              <p className="text-muted-foreground text-xs">{entry.evidence}</p>
              {'requirements' in entry && (
                <p className="text-muted-foreground text-xs">
                  Graduation gates: {entry.requirements.join(', ')}.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
