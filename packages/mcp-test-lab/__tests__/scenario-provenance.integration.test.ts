import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_EVERYTHING_PROFILE } from '../src/official-everything-profile';
import { MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE, MCP_LAB_SDK_SOURCE } from '../src/scenario';

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
});
