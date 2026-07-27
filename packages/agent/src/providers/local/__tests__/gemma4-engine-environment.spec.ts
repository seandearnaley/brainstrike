import { resolveLocalArtifactRemotePathTemplate } from '@brainstrike/assistant-contract/local-llm-artifacts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureTransformersEnvironment } from '../gemma4-engine';

const originalWindow = globalThis.window;

describe('configureTransformersEnvironment', () => {
  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow;
      return;
    }
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('uses the web proxy contract for browser runtime fetches', () => {
    globalThis.window = {
      location: {
        origin: 'http://localhost:8080',
        protocol: 'http:',
      },
    } as unknown as Window & typeof globalThis;

    const environment: {
      allowRemoteModels?: boolean;
      remoteHost?: string;
      remotePathTemplate?: string;
    } = {};

    configureTransformersEnvironment(environment);

    expect(environment).toEqual({
      allowRemoteModels: true,
      remoteHost: 'http://localhost:8080/api/hf/',
      remotePathTemplate: resolveLocalArtifactRemotePathTemplate(),
    });
  });

  it('uses Hugging Face directly for Electron renderer fetches', () => {
    globalThis.window = {
      electronAPI: {},
      location: {
        protocol: 'http:',
      },
    } as unknown as Window & typeof globalThis;

    const environment: {
      allowRemoteModels?: boolean;
      remoteHost?: string;
      remotePathTemplate?: string;
    } = {};

    configureTransformersEnvironment(environment);

    expect(environment).toEqual({
      allowRemoteModels: true,
      remoteHost: 'https://huggingface.co/',
      remotePathTemplate: resolveLocalArtifactRemotePathTemplate(),
    });
  });
});
