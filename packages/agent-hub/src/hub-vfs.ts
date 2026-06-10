import { countTokensHeuristic } from '@brainstrike/utils/token-counting-heuristics';
import type {
  HubAgent,
  HubMessage,
  VfsEntry,
  VfsReadInput,
  VfsReadResult,
  VfsWriteInput,
} from './types.js';

/** Mirrors the countTokensHeuristic ratio so offsets map cleanly to chars. */
const CHARS_PER_TOKEN = 4;
/** Hard cap per artifact; the hub is a coordination space, not blob storage. */
const MAX_ARTIFACT_CHARS = 512_000;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface StoredArtifact {
  content: string;
  tokenCount: number;
  updatedAt: number;
}

export interface HubVfsDeps {
  errorFactory: (message: string) => Error;
  getChannelMessages: (channel: string) => HubMessage[];
  listAgents: () => HubAgent[];
  listChannels: () => string[];
  now: () => number;
  /** Resolves the registered caller or throws the standard register-first error. */
  requireSender: (sessionKey: string) => HubAgent;
}

export interface HubVfs {
  list(): VfsEntry[];
  read(input: VfsReadInput): VfsReadResult;
  write(input: VfsWriteInput): VfsEntry;
}

function renderProfile(agent: HubAgent): string {
  const lines = [
    `# ${agent.name}`,
    '',
    `- status: ${agent.status}`,
    `- color: ${agent.color}`,
    `- program: ${agent.program ?? 'unknown'}`,
    `- worktree: ${agent.worktree ?? 'unknown'}`,
    `- capabilities: ${agent.capabilities.length > 0 ? agent.capabilities.join(', ') : 'none declared'}`,
    `- tokensSent: ${agent.tokensSent}`,
    `- tokensReceived: ${agent.tokensReceived}`,
    `- joinedAt: ${agent.joinedAt}`,
  ];
  return lines.join('\n');
}

function renderChannelLog(channel: string, messages: HubMessage[]): string {
  const header = `# ${channel}`;
  const body = messages.map((message) => `${message.fromName}: ${message.text}`).join('\n');
  return body.length > 0 ? `${header}\n\n${body}` : header;
}

function sliceByTokens(
  path: string,
  content: string,
  offsetTokens: number,
  maxTokens: number | undefined
): VfsReadResult {
  const offsetChars = offsetTokens * CHARS_PER_TOKEN;
  const endChars =
    maxTokens === undefined
      ? content.length
      : Math.min(content.length, offsetChars + maxTokens * CHARS_PER_TOKEN);
  const slice = content.slice(offsetChars, endChars);
  const truncated = endChars < content.length;
  return {
    content: slice,
    nextOffsetTokens: truncated ? offsetTokens + (maxTokens ?? 0) : null,
    path,
    tokenCount: countTokensHeuristic(slice),
    totalTokens: countTokensHeuristic(content),
    truncated,
  };
}

export function createHubVfs(deps: HubVfsDeps): HubVfs {
  const { errorFactory, getChannelMessages, listAgents, listChannels, now, requireSender } = deps;
  const artifactsByAgentId = new Map<string, Map<string, StoredArtifact>>();

  function resolveContent(path: string): string | null {
    const channelMatch = path.match(/^\/channels\/(.+)\.md$/);
    if (channelMatch?.[1] && listChannels().includes(channelMatch[1])) {
      return renderChannelLog(channelMatch[1], getChannelMessages(channelMatch[1]));
    }
    const profileMatch = path.match(/^\/agents\/([^/]+)\/profile\.md$/);
    if (profileMatch) {
      const agent = listAgents().find((entry) => entry.name === profileMatch[1]);
      return agent ? renderProfile(agent) : null;
    }
    const artifactMatch = path.match(/^\/agents\/([^/]+)\/shared\/(.+)$/);
    if (artifactMatch) {
      const agent = listAgents().find((entry) => entry.name === artifactMatch[1]);
      if (!agent) {
        return null;
      }
      const artifact = artifactsByAgentId.get(agent.agentId)?.get(artifactMatch[2] ?? '');
      return artifact ? artifact.content : null;
    }
    return null;
  }

  function list(): VfsEntry[] {
    const entries: VfsEntry[] = [];
    for (const channel of listChannels()) {
      const content = renderChannelLog(channel, getChannelMessages(channel));
      entries.push({
        kind: 'channel-log',
        path: `/channels/${channel}.md`,
        tokenCount: countTokensHeuristic(content),
        updatedAt: getChannelMessages(channel).at(-1)?.postedAt ?? 0,
      });
    }
    for (const agent of listAgents()) {
      entries.push({
        kind: 'profile',
        ownerName: agent.name,
        path: `/agents/${agent.name}/profile.md`,
        tokenCount: countTokensHeuristic(renderProfile(agent)),
        updatedAt: agent.lastSeenAt,
      });
      const artifacts = artifactsByAgentId.get(agent.agentId);
      if (!artifacts) {
        continue;
      }
      for (const [name, artifact] of artifacts) {
        entries.push({
          kind: 'artifact',
          ownerName: agent.name,
          path: `/agents/${agent.name}/shared/${name}`,
          tokenCount: artifact.tokenCount,
          updatedAt: artifact.updatedAt,
        });
      }
    }
    return entries;
  }

  function read(input: VfsReadInput): VfsReadResult {
    const reader = requireSender(input.sessionKey);
    const content = resolveContent(input.path);
    if (content === null) {
      throw errorFactory(`Unknown VFS path '${input.path}'. Use vfs_list to discover paths.`);
    }
    const result = sliceByTokens(input.path, content, input.offsetTokens ?? 0, input.maxTokens);
    reader.tokensReceived += result.tokenCount;
    reader.lastSeenAt = now();
    return result;
  }

  function write(input: VfsWriteInput): VfsEntry {
    const owner = requireSender(input.sessionKey);
    if (!ARTIFACT_NAME_PATTERN.test(input.name)) {
      throw errorFactory(
        `Invalid artifact name '${input.name}'. Use letters, digits, dots, dashes, underscores (max 128 chars, no slashes).`
      );
    }
    if (input.content.length > MAX_ARTIFACT_CHARS) {
      throw errorFactory(
        `Artifact too large (${input.content.length} chars; max ${MAX_ARTIFACT_CHARS}). Share a summary instead.`
      );
    }
    const artifacts = artifactsByAgentId.get(owner.agentId) ?? new Map<string, StoredArtifact>();
    artifactsByAgentId.set(owner.agentId, artifacts);
    const stored: StoredArtifact = {
      content: input.content,
      tokenCount: countTokensHeuristic(input.content),
      updatedAt: now(),
    };
    artifacts.set(input.name, stored);
    owner.tokensSent += stored.tokenCount;
    owner.lastSeenAt = stored.updatedAt;
    return {
      kind: 'artifact',
      ownerName: owner.name,
      path: `/agents/${owner.name}/shared/${input.name}`,
      tokenCount: stored.tokenCount,
      updatedAt: stored.updatedAt,
    };
  }

  return { list, read, write };
}
