import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
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

const execFileAsync = promisify(execFile);

describe('MCP lab upstream provenance', () => {
  it('verifies the pinned SDK tag against its live peeled commit', async () => {
    const tagRef = `refs/tags/${MCP_LAB_SDK_SOURCE.tag}`;
    const peeledRef = `${tagRef}^{}`;
    const { stdout } = await execFileAsync('git', [
      'ls-remote',
      MCP_LAB_SDK_SOURCE.repositoryUrl,
      tagRef,
      peeledRef,
    ]);
    const remoteRefs = new Map(
      stdout
        .trim()
        .split('\n')
        .map((line): readonly [string, string] => {
          const [sha, ref] = line.split('\t');
          if (sha === undefined || ref === undefined) {
            throw new Error('Upstream MCP SDK tag response is malformed');
          }
          return [ref, sha];
        })
    );

    expect(remoteRefs.get(peeledRef)).toBe(MCP_LAB_SDK_SOURCE.commitSha);
  });

  it('verifies the upstream source digest and every executable profile anchor', async () => {
    const source = MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE;
    const rawUrl = `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/${source.commitSha}/${source.path}`;
    const response = await fetch(rawUrl);
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
  });

  it('verifies the partial Tasks provenance: the pinned core carries the older Tasks shape', async () => {
    // BST-1566: the Tasks profile is Brainstrike-owned because the pinned core
    // registers the pre-2026-07-28 shape; the digest and these anchors prove
    // exactly that, so the evidence cannot overclaim upstream coverage.
    const source = MCP_LAB_SDK_TASKS_SCHEMA_SOURCE;
    const rawUrl = `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/${source.commitSha}/${source.path}`;
    const response = await fetch(rawUrl);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("'tasks/get'");
    expect(text).toContain("'tasks/cancel'");
    expect(text).not.toContain('tasks/update');
    expect(text).not.toContain(`${TASKS_PROFILE.notificationMethod}'`);
  });

  it('verifies the pinned ext-apps tag and every example-server file digest and anchor', async () => {
    // BST-1572: v1.7.5 is a lightweight tag, so the tag object IS the commit.
    const { stdout } = await execFileAsync('git', [
      'ls-remote',
      MCP_LAB_EXT_APPS_SOURCE.repositoryUrl,
      `refs/tags/${MCP_LAB_EXT_APPS_SOURCE.tag}`,
    ]);
    expect(stdout.trim().split('\t')[0]).toBe(MCP_LAB_EXT_APPS_SOURCE.commitSha);
    expect(APPS_PROFILE.upstream.files['server.ts']).toBe(
      MCP_LAB_EXT_APPS_EXAMPLE_SERVER_SOURCE.sha256
    );
    const texts = new Map<string, string>();
    for (const [file, sha256] of Object.entries(APPS_PROFILE.upstream.files)) {
      const rawUrl = `https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/${MCP_LAB_EXT_APPS_SOURCE.commitSha}/${APPS_PROFILE.upstream.directory}/${file}`;
      const response = await fetch(rawUrl);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      texts.set(file, new TextDecoder().decode(bytes));
    }
    expect(texts.get('mcp-app.html')).toBe(APPS_PROFILE.document);
    // The profile pins BOTH resource-URI metadata keys because the pinned
    // helper writes the legacy flat key whenever `_meta.ui.resourceUri` is set.
    const helperUrl = `https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/${MCP_LAB_EXT_APPS_SOURCE.commitSha}/${APPS_PROFILE.upstream.helper.path}`;
    const helperResponse = await fetch(helperUrl);
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
  });
});
