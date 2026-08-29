import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MCP_LAB_SDK_SOURCE } from '../src/scenario';

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
});
