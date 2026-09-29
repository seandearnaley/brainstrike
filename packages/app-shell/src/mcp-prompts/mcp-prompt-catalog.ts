/**
 * Pure projection of the revisioned MCP host snapshot into the composer's
 * selectable prompt entries (BST-1592).
 *
 * No React, no bridge, no UI: the gating rules are unit-tested directly.
 * A prompt is selectable only while its server is CONNECTED, advertises the
 * `prompts` catalog feature, and actually listed it — the same authority the
 * `mcp:content:*` port re-checks around every invocation, so a stale entry can
 * never silently target a retired generation (the port rejects it visibly).
 */
import type {
  ConfiguredMcpServerId,
  McpHostServerSnapshot,
  McpHostSnapshot,
} from '@brainstrike/assistant-contract';

/** Namespace prefix for every MCP prompt slash command id. */
export const MCP_PROMPT_COMMAND_PREFIX = 'mcp';

export interface McpPromptArgumentDescriptor {
  readonly description?: string | undefined;
  readonly name: string;
  readonly required: boolean;
}

export interface McpPromptEntry {
  readonly arguments: readonly McpPromptArgumentDescriptor[];
  /**
   * `mcp:<configuredServerId>:<promptName>` — unique across connected servers.
   * Both components have `:` and `\` escaped so the id stays injective; see
   * `escapeCommandIdComponent`.
   */
  readonly commandId: string;
  /** Whether the server advertises `completion/complete` for argument suggestions. */
  readonly completionSupported: boolean;
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly description?: string | undefined;
  readonly generation: number;
  /** Prompt title (or name) followed by the configured server id, which disambiguates. */
  readonly label: string;
  readonly promptName: string;
  /** Prompt title when the server supplies one, else the wire name. */
  readonly title: string;
}

type ConnectedServer = Extract<McpHostServerSnapshot, { state: 'connected' }>;
type CatalogPrompt = NonNullable<
  NonNullable<ConnectedServer['catalog']>['prompts']
>['prompts'][number];

function isConnected(server: McpHostServerSnapshot): server is ConnectedServer {
  return server.state === 'connected';
}

function displayTitle(title: string | undefined, fallback: string): string {
  const normalized = title?.trim();
  return normalized ? normalized : fallback;
}

function toArgumentDescriptors(prompt: CatalogPrompt): readonly McpPromptArgumentDescriptor[] {
  return (prompt.arguments ?? []).map((argument) => ({
    ...(argument.description === undefined ? {} : { description: argument.description }),
    name: argument.name,
    required: argument.required === true,
  }));
}

/**
 * Escape the `:` delimiter (and the escape character itself) inside one command
 * id component.
 *
 * `mcp:<server>:<prompt>` is unique only if the delimiter cannot occur INSIDE a
 * component, and both components may carry one: `ConfiguredMcpServerIdSchema`
 * rejects only empty/reserved/whitespace-padded ids and Unicode control or
 * format characters, and a prompt name is whatever the server published. Plain
 * concatenation is therefore not injective — server `a` + prompt `b:c` and
 * server `a:b` + prompt `c` both produce `mcp:a:b:c`, so `selectMcpPromptEntries`
 * would treat one as a duplicate of the other and DROP a valid prompt, defeating
 * the cross-server disambiguation the id exists for.
 *
 * Escaping rather than percent/length encoding because the id is user-visible:
 * the popover matches on it and the user types it. Every ordinary id (no `:`, no
 * `\`) is byte-identical after this, and the menu LABEL keeps the raw values.
 */
function escapeCommandIdComponent(value: string): string {
  return value.replace(/[\\:]/gu, (character) => `\\${character}`);
}

function toEntry(server: ConnectedServer, prompt: CatalogPrompt): McpPromptEntry {
  const title = displayTitle(prompt.title, prompt.name);
  return {
    arguments: toArgumentDescriptors(prompt),
    commandId: `${MCP_PROMPT_COMMAND_PREFIX}:${escapeCommandIdComponent(server.configuredServerId)}:${escapeCommandIdComponent(prompt.name)}`,
    completionSupported: server.catalog?.features.completion === true,
    configuredServerId: server.configuredServerId,
    ...(prompt.description === undefined ? {} : { description: prompt.description }),
    generation: server.generation,
    label: `${title} · ${server.configuredServerId}`,
    promptName: prompt.name,
    title,
  };
}

/**
 * Every prompt the user may select right now, ordered by configured server id
 * then prompt name so the "/" menu is stable across snapshot revisions.
 *
 * Two servers may expose the same prompt name, so the command id and the label
 * both carry the configured server id: the user always sees WHICH server a
 * prompt came from. A single server listing one name twice would collide, so
 * the first occurrence wins and the duplicate is dropped rather than producing
 * two identical, indistinguishable rows. That drop is only ever a REAL duplicate
 * because `escapeCommandIdComponent` keeps `<server, prompt>` → id injective.
 */
export function selectMcpPromptEntries(snapshot: McpHostSnapshot): readonly McpPromptEntry[] {
  const entries: McpPromptEntry[] = [];
  const seen = new Set<string>();
  for (const server of [...snapshot.servers].sort((left, right) =>
    left.configuredServerId.localeCompare(right.configuredServerId)
  )) {
    if (!isConnected(server) || server.catalog?.features.prompts !== true) {
      continue;
    }
    const prompts = [...(server.catalog.prompts?.prompts ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const prompt of prompts) {
      const entry = toEntry(server, prompt);
      if (seen.has(entry.commandId)) {
        continue;
      }
      seen.add(entry.commandId);
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Whether `entry` is still backed by a live authority in `snapshot`: the same
 * server, the same generation, still connected, still advertising prompts.
 * The dialog polls this so a server that disconnects while the user is filling
 * arguments fails VISIBLY instead of submitting into a retired generation.
 */
export function isMcpPromptEntryLive(
  entry: McpPromptEntry,
  snapshot: McpHostSnapshot | null
): boolean {
  if (!snapshot) {
    return false;
  }
  const server = snapshot.servers.find(
    ({ configuredServerId }) => configuredServerId === entry.configuredServerId
  );
  return (
    server !== undefined &&
    server.generation === entry.generation &&
    isConnected(server) &&
    server.catalog?.features.prompts === true
  );
}
