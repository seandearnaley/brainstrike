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

    configureTransformersEnvironment(environment, null);

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

    configureTransformersEnvironment(environment, null);

    expect(environment).toEqual({
      allowRemoteModels: true,
      remoteHost: 'https://huggingface.co/',
      remotePathTemplate: resolveLocalArtifactRemotePathTemplate(),
    });
  });

  // BST-2003: browser ONNX Runtime loads its WASM only from the app's own files.
  const paths = {
    mjs: 'file:///app/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-1a.mjs',
    wasm: 'file:///app/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-2b.wasm',
  };

  it('points browser ONNX Runtime at the app-served WASM files', () => {
    const wasm: { wasmPaths?: unknown } = {};
    const environment = { backends: { onnx: { versions: { web: '1.31.0' }, wasm } } };

    configureTransformersEnvironment(environment, paths);

    expect(wasm.wasmPaths).toEqual(paths);
  });

  it('refuses browser ONNX Runtime without app-served WASM files', () => {
    const environment = { backends: { onnx: { versions: { web: '1.31.0' }, wasm: {} } } };

    expect(() => configureTransformersEnvironment(environment, null)).toThrow(
      'never loads ONNX Runtime from a CDN'
    );
  });
});
