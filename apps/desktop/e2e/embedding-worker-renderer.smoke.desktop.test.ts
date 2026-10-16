import * as shared from './embedding-worker-renderer.shared';
import { expect, test } from './embedding-worker-renderer.shared';

const {
  AUTOMATIC_WEBGPU_UNAVAILABLE_ERROR,
  ERROR_LOCATOR,
  ensureEmbeddingHostStarted,
  getEmbeddingHostPage,
  getEmbeddingHostStatus,
  getRendererLogRecords,
  isDatabaseError,
  recordContainsText,
  requestLocalQueryEmbedding,
  setVectorDevicePreference,
  waitForAppReadyInTest,
  withTemporaryProcessEnv,
} = shared;

test.describe('Embedding Host Renderer - smoke', () => {
  test('@desktop-runtime-hosts @desktop-embedding-lifecycle @desktop-embedding-webgpu-configured defers hidden embedding host startup until first use when WebGPU is configured', async ({
    electron,
  }) => {
    const context = await electron.restart();
    const window = context.window;
    await waitForAppReadyInTest(window);

    if (await isDatabaseError(window)) {
      await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const initialStatus = await getEmbeddingHostStatus(window);

    expect(initialStatus.state).toBe('stopped');
    expect(initialStatus.lastError).toBeNull();

    await setVectorDevicePreference(window, 'webgpu');
    const status = await ensureEmbeddingHostStarted(window);

    expect(status.state).toBe('running');
    expect(status.lastError).toBeNull();

    const hostPage = await getEmbeddingHostPage(window);
    await hostPage.waitForTimeout(1000);
    const hostLogs = await getRendererLogRecords(hostPage);

    // Startup loads no model; the first embedding does (#3595).
    expect((await getEmbeddingHostStatus(window)).embeddingRuntime).toBeUndefined();
    expect(
      hostLogs.some((record) => recordContainsText(record, 'Warmup job submission failed'))
    ).toBe(false);
    expect(
      hostLogs.some((record) => recordContainsText(record, 'worker_model_dimension_notice'))
    ).toBe(false);
    expect(
      hostLogs.some((record) =>
        recordContainsText(record, 'Failed to create WebGPU Context Provider')
      )
    ).toBe(false);
    expect(hostLogs.some((record) => recordContainsText(record, 'Pipeline load failed'))).toBe(
      false
    );
    expect(
      hostLogs.some((record) => recordContainsText(record, 'Workerpool embedding task failed'))
    ).toBe(false);
  });

  test('@desktop-embedding-webgpu-unsupported surfaces unavailable automatic WebGPU selection exactly', async ({
    electron,
  }) => {
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_E2E_ALLOW_GPU: undefined,
      CI: 'true',
      ELECTRON_DISABLE_GPU: '1',
    });
    try {
      const context = await electron.restart();
      const window = context.window;
      const output: string[] = [];
      for (const stream of [context.app.process().stdout, context.app.process().stderr]) {
        stream?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
      }
      await waitForAppReadyInTest(window);

      if (await isDatabaseError(window)) {
        await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      const initialStatus = await getEmbeddingHostStatus(window);
      expect(initialStatus.state).toBe('stopped');
      expect(initialStatus.lastError).toBeNull();

      // Startup chooses no device (#3595), so the host runs. The first local query
      // chooses one, and refuses to fall back to WASM.
      const status = await ensureEmbeddingHostStarted(window);
      expect(status.state).toBe('running');
      expect(status.lastError).toBeNull();
      expect((await requestLocalQueryEmbedding(window)).ok).toBe(false);
      // The caller sees a redacted fault; main logs the exact reason.
      await expect.poll(() => output.join('')).toContain(AUTOMATIC_WEBGPU_UNAVAILABLE_ERROR);
      expect((await getEmbeddingHostStatus(window)).embeddingRuntime).toBeUndefined();
    } finally {
      restoreEnv();
      await electron.restart();
    }
  });
});
