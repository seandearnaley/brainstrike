import { describe, expect, it } from 'vitest';
import {
  configureAgentDevtoolsCommandLine,
  resolveAgentDevtoolsConfig,
  toAgentDevtoolsSwitches,
} from '../../agent-devtools-config';

describe('agent devtools config', () => {
  it('is disabled by default', () => {
    expect(resolveAgentDevtoolsConfig({}, [])).toEqual({ enabled: false });
  });

  it('enables from environment with safe defaults', () => {
    expect(resolveAgentDevtoolsConfig({ BRAINSTRIKE_AGENT_DEVTOOLS: '1' }, [])).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 9222,
    });
  });

  it('enables from argv with an explicit port', () => {
    expect(
      resolveAgentDevtoolsConfig({}, [
        '--brainstrike-agent-devtools',
        '--brainstrike-agent-devtools-port=9333',
      ])
    ).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 9333,
    });
  });

  it('rejects non-local hosts', () => {
    expect(() =>
      resolveAgentDevtoolsConfig(
        {
          BRAINSTRIKE_AGENT_DEVTOOLS: '1',
          BRAINSTRIKE_AGENT_DEVTOOLS_HOST: '0.0.0.0',
        },
        []
      )
    ).toThrow('BRAINSTRIKE_AGENT_DEVTOOLS_HOST must be 127.0.0.1.');
  });

  it('rejects invalid ports', () => {
    expect(() =>
      resolveAgentDevtoolsConfig(
        {
          BRAINSTRIKE_AGENT_DEVTOOLS: '1',
          BRAINSTRIKE_AGENT_DEVTOOLS_PORT: '70000',
        },
        []
      )
    ).toThrow('BRAINSTRIKE_AGENT_DEVTOOLS_PORT must be an integer from 1024 to 65535.');
  });

  it('renders Electron command-line switches', () => {
    expect(toAgentDevtoolsSwitches({ enabled: true, host: '127.0.0.1', port: 9222 })).toEqual([
      ['remote-debugging-port', '9222'],
      ['remote-debugging-address', '127.0.0.1'],
    ]);
  });

  it('applies switches to an injected Electron command line', () => {
    const calls: Array<readonly [string, string]> = [];
    configureAgentDevtoolsCommandLine(
      { appendSwitch: (name: string, value: string) => calls.push([name, value]) },
      { BRAINSTRIKE_AGENT_DEVTOOLS: '1' },
      []
    );
    expect(calls).toEqual([
      ['remote-debugging-port', '9222'],
      ['remote-debugging-address', '127.0.0.1'],
    ]);
  });
});
