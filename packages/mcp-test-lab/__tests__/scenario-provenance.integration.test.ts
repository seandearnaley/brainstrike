import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APPS_PROFILE } from '../src/apps-profile';
import { OFFICIAL_EVERYTHING_PROFILE } from '../src/official-everything-profile';
import {
  MCP_LAB_EXT_APPS_EXAMPLE_SERVER_SOURCE,
  MCP_LAB_EXT_APPS_SOURCE,
  MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE,
  MCP_LAB_SDK_SOURCE,
  MCP_LAB_SDK_TASKS_SCHEMA_SOURCE,
} from '../src/scenario';
import { TASKS_PROFILE } from '../src/tasks-profile';

const UPSTREAM_IO_TIMEOUT_MS = 30_000;
// One shared I/O deadline per case, plus five seconds for assertions/teardown.
const PROVENANCE_TEST_TIMEOUT_MS = UPSTREAM_IO_TIMEOUT_MS + 5000;
const upstreamGitObjectSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  type: z.enum(['commit', 'tag']),
});
const upstreamGitRecordSchema = z.object({ object: upstreamGitObjectSchema });
const upstreamGitRefSchema = upstreamGitRecordSchema.extend({ ref: z.string() });
const upstreamGitTagSchema = upstreamGitRecordSchema.extend({
  sha: upstreamGitObjectSchema.shape.sha,
  tag: z.string(),
});

async function readUpstreamGitRecord(
  repositoryUrl: string,
  path: string,
  signal: AbortSignal
): Promise<unknown> {
  const repository = new URL(repositoryUrl);
  expect(repository.origin).toBe('https://github.com');
  const repositoryPath = repository.pathname.replace(/\.git$/u, '');
  const response = await fetch(`https://api.github.com/repos${repositoryPath}/git/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    signal,
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe('MCP lab upstream provenance', () => {
  it(
    'verifies the pinned SDK tag against its live peeled commit',
    async () => {
      const signal = AbortSignal.timeout(UPSTREAM_IO_TIMEOUT_MS);
      const tagRef = `refs/tags/${MCP_LAB_SDK_SOURCE.tag}`;
      const reference = upstreamGitRefSchema.parse(
        await readUpstreamGitRecord(
          MCP_LAB_SDK_SOURCE.repositoryUrl,
          `ref/tags/${encodeURIComponent(MCP_LAB_SDK_SOURCE.tag)}`,
          signal
        )
      );
      expect(reference.ref).toBe(tagRef);
      expect(reference.object.type).toBe('tag');
      const peeled = upstreamGitTagSchema.parse(
        await readUpstreamGitRecord(
          MCP_LAB_SDK_SOURCE.repositoryUrl,
          `tags/${reference.object.sha}`,
          signal
        )
      );
      expect(peeled.sha).toBe(reference.object.sha);
      expect(peeled.tag).toBe(MCP_LAB_SDK_SOURCE.tag);
      expect(peeled.object.type).toBe('commit');
      expect(peeled.object.sha).toBe(MCP_LAB_SDK_SOURCE.commitSha);
    },
    PROVENANCE_TEST_TIMEOUT_MS
  );

  it(
    'verifies the upstream source digest and every executable profile anchor',
    async () => {
      const signal = AbortSignal.timeout(UPSTREAM_IO_TIMEOUT_MS);
      const source = MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE;
      const rawUrl = `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/${source.commitSha}/${source.path}`;
      const response = await fetch(rawUrl, { signal });
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
      const text = new TextDecoder().decode(bytes);
      const anchors = [
        OFFICIAL_EVERYTHING_PROFILE.server.name,
        OFFICIAL_EVERYTHING_PROFILE.tools.simpleText.name,
        OFFICIAL_EVERYTHING_PROFILE.tools.simpleText.text,
        OFFICIAL_EVERYTHING_PROFILE.tools.error.name,
        OFFICIAL_EVERYTHING_PROFILE.tools.error.message,
        OFFICIAL_EVERYTHING_PROFILE.resource.uri,
        OFFICIAL_EVERYTHING_PROFILE.resource.text,
        OFFICIAL_EVERYTHING_PROFILE.prompt.name,
        OFFICIAL_EVERYTHING_PROFILE.prompt.message,
        'completion/complete',
      ];
      for (const anchor of anchors) {
        expect(text).toContain(anchor);
      }
    },
    PROVENANCE_TEST_TIMEOUT_MS
  );

  it(
    'verifies the partial Tasks provenance: the pinned core carries the older Tasks shape',
    async () => {
      const signal = AbortSignal.timeout(UPSTREAM_IO_TIMEOUT_MS);
      // BST-1566: the Tasks profile is Brainstrike-owned because the pinned core
      // registers the pre-2026-07-28 shape; the digest and these anchors prove
      // exactly that, so the evidence cannot overclaim upstream coverage.
      const source = MCP_LAB_SDK_TASKS_SCHEMA_SOURCE;
      const rawUrl = `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/${source.commitSha}/${source.path}`;
      const response = await fetch(rawUrl, { signal });
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain("'tasks/get'");
      expect(text).toContain("'tasks/cancel'");
      expect(text).not.toContain('tasks/update');
      expect(text).not.toContain(`${TASKS_PROFILE.notificationMethod}'`);
    },
    PROVENANCE_TEST_TIMEOUT_MS
  );

  it(
    'verifies the pinned ext-apps tag and every example-server file digest and anchor',
    async () => {
      const signal = AbortSignal.timeout(UPSTREAM_IO_TIMEOUT_MS);
      // BST-1572: v1.7.5 is a lightweight tag, so the tag object IS the commit.
      const reference = upstreamGitRefSchema.parse(
        await readUpstreamGitRecord(
          MCP_LAB_EXT_APPS_SOURCE.repositoryUrl,
          `ref/tags/${encodeURIComponent(MCP_LAB_EXT_APPS_SOURCE.tag)}`,
          signal
        )
      );
      expect(reference.ref).toBe(`refs/tags/${MCP_LAB_EXT_APPS_SOURCE.tag}`);
      expect(reference.object.type).toBe('commit');
      expect(reference.object.sha).toBe(MCP_LAB_EXT_APPS_SOURCE.commitSha);
      expect(APPS_PROFILE.upstream.files['server.ts']).toBe(
        MCP_LAB_EXT_APPS_EXAMPLE_SERVER_SOURCE.sha256
      );
      const texts = new Map<string, string>();
      for (const [file, sha256] of Object.entries(APPS_PROFILE.upstream.files)) {
        const rawUrl = `https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/${MCP_LAB_EXT_APPS_SOURCE.commitSha}/${APPS_PROFILE.upstream.directory}/${file}`;
        const response = await fetch(rawUrl, { signal });
        expect(response.status).toBe(200);
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
        texts.set(file, new TextDecoder().decode(bytes));
      }
      expect(texts.get('mcp-app.html')).toBe(APPS_PROFILE.document);
      // The profile pins BOTH resource-URI metadata keys because the pinned
      // helper writes the legacy flat key whenever `_meta.ui.resourceUri` is set.
      const helperUrl = `https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/${MCP_LAB_EXT_APPS_SOURCE.commitSha}/${APPS_PROFILE.upstream.helper.path}`;
      const helperResponse = await fetch(helperUrl, { signal });
      expect(helperResponse.status).toBe(200);
      const helperBytes = new Uint8Array(await helperResponse.arrayBuffer());
      expect(createHash('sha256').update(helperBytes).digest('hex')).toBe(
        APPS_PROFILE.upstream.helper.sha256
      );
      const helperText = new TextDecoder().decode(helperBytes);
      expect(helperText).toContain('If _meta.ui.resourceUri is set, also set the legacy flat key');
      expect(helperText).toContain(
        'normalizedMeta = { ...meta, [RESOURCE_URI_META_KEY]: uiMeta.resourceUri };'
      );
      expect(helperText).toContain('export { RESOURCE_URI_META_KEY, RESOURCE_MIME_TYPE };');
      const serverText = texts.get('server.ts') ?? '';
      for (const anchor of [
        APPS_PROFILE.server.name,
        APPS_PROFILE.tool.name,
        APPS_PROFILE.tool.title,
        APPS_PROFILE.tool.description,
        APPS_PROFILE.resource.uri,
        'RESOURCE_MIME_TYPE',
        '_meta: { ui: { resourceUri } }',
      ]) {
        expect(serverText).toContain(anchor);
      }
    },
    PROVENANCE_TEST_TIMEOUT_MS
  );
});
