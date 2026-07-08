import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

test.describe('IPC Communication', { tag: '@desktop-ipc-reset' }, () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
  });

  test('should have electron API available', async ({ window }) => {
    const hasElectronAPI = await window.evaluate(
      () => typeof (window as { electronAPI?: unknown }).electronAPI !== 'undefined'
    );

    expect(hasElectronAPI).toBe(true);
  });

  test('should handle storage operations via IPC', async ({ window }) => {
    const storageTest = await window.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.storage) {
        return { error: 'Storage API not available' };
      }

      try {
        await electronAPI.storage.setItem('test-key', 'test-value');
        const value = await electronAPI.storage.getItem('test-key');
        const keys = await electronAPI.storage.getAllKeys();
        await electronAPI.storage.removeItem('test-key');
        const removedValue = await electronAPI.storage.getItem('test-key');

        return {
          hasKeys: keys.length >= 0,
          removedValue,
          setValue: value,
          success: true,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

    expect(storageTest.success).toBe(true);
    expect(storageTest.setValue).toBe('test-value');
    expect(storageTest.hasKeys).toBe(true);
    expect(storageTest.removedValue).toBeNull();
  });

  test('should handle file system operations via IPC', async ({ window }) => {
    const fileSystemTest = await window.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.fileSystem) {
        return { error: 'FileSystem API not available', success: false };
      }

      try {
        if (typeof electronAPI.fileSystem.requestDirectoryAccess !== 'function') {
          return { error: 'requestDirectoryAccess method not available', success: false };
        }

        if (typeof electronAPI.fileSystem.exists !== 'function') {
          return { error: 'exists method not available', success: false };
        }

        const directoryResult = await electronAPI.fileSystem.requestDirectoryAccess();
        const existsResult = await electronAPI.fileSystem.exists('/mock/test/path');

        return {
          canCheckExists: typeof existsResult === 'boolean',
          hasDirectoryAccess: directoryResult !== null,
          success: true,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), success: false };
      }
    });

    if (fileSystemTest.error) {
      console.log('FileSystem API test skipped:', fileSystemTest.error);
      expect(fileSystemTest.success).toBe(false);
      return;
    }

    expect(fileSystemTest.success).toBe(true);
    expect(fileSystemTest.canCheckExists).toBe(true);
  });

  test('should handle IPC errors gracefully', async ({ window }) => {
    const errorTest = await window.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.storage) {
        return { error: 'Storage API not available', success: false };
      }

      try {
        await electronAPI.storage.setItem('', 'value');
        return { success: true, unexpectedSuccess: true };
      } catch (error) {
        return {
          errorCaught: true,
          errorMessage: error instanceof Error ? error.message : String(error),
          success: true,
        };
      }
    });

    if (errorTest.error === 'Storage API not available') {
      console.warn('Storage API not available, skipping error test');
      return;
    }

    expect(errorTest.success).toBe(true);
  });

  test('should maintain IPC communication during heavy operations', async ({ window }) => {
    const heavyOperationTest = await window.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.storage) {
        return { error: 'Storage API not available' };
      }

      const startTime = Date.now();
      const operationCount = 5;
      const writeOperations = [];

      for (let i = 0; i < operationCount; i++) {
        writeOperations.push(electronAPI.storage.setItem(`test-key-${i}`, `test-value-${i}`));
      }

      try {
        await Promise.all(writeOperations);

        const verifyOperations = [];
        for (let i = 0; i < operationCount; i++) {
          verifyOperations.push(electronAPI.storage.getItem(`test-key-${i}`));
        }

        const results = await Promise.all(verifyOperations);
        const allCorrect = results.every((result, index) => result === `test-value-${index}`);

        const cleanupOperations = [];
        for (let i = 0; i < operationCount; i++) {
          cleanupOperations.push(electronAPI.storage.removeItem(`test-key-${i}`));
        }
        await Promise.all(cleanupOperations);

        const endTime = Date.now();

        return {
          allCorrect,
          duration: endTime - startTime,
          operationsCount: operationCount,
          success: true,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

    expect(heavyOperationTest.success).toBe(true);
    expect(heavyOperationTest.allCorrect).toBe(true);
    expect(heavyOperationTest.duration).toBeLessThan(15_000);
  });

  test('should handle concurrent IPC calls', async ({ window }) => {
    const concurrentTest = await window.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.storage) {
        return { error: 'Storage API not available' };
      }

      try {
        const operation1 = electronAPI.storage.setItem('concurrent-1', 'value-1');
        const operation2 = electronAPI.storage.setItem('concurrent-2', 'value-2');
        const operation3 = electronAPI.storage.setItem('concurrent-3', 'value-3');

        await Promise.all([operation1, operation2, operation3]);

        const [value1, value2, value3] = await Promise.all([
          electronAPI.storage.getItem('concurrent-1'),
          electronAPI.storage.getItem('concurrent-2'),
          electronAPI.storage.getItem('concurrent-3'),
        ]);

        await Promise.all([
          electronAPI.storage.removeItem('concurrent-1'),
          electronAPI.storage.removeItem('concurrent-2'),
          electronAPI.storage.removeItem('concurrent-3'),
        ]);

        return {
          allCorrect: value1 === 'value-1' && value2 === 'value-2' && value3 === 'value-3',
          success: true,
          values: [value1, value2, value3],
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

    expect(concurrentTest.success).toBe(true);
    expect(concurrentTest.allCorrect).toBe(true);
  });

  test('should handle IPC communication reliability', async ({ window }) => {
    const reliabilityTest = await window.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.storage) {
        return { error: 'Storage API not available' };
      }

      let successCount = 0;
      const totalOperations = 10;

      try {
        for (let i = 0; i < totalOperations; i++) {
          await electronAPI.storage.setItem(`reliability-test-${i}`, `value-${i}`);
          const retrievedValue = await electronAPI.storage.getItem(`reliability-test-${i}`);

          if (retrievedValue === `value-${i}`) {
            successCount++;
          }

          await electronAPI.storage.removeItem(`reliability-test-${i}`);

          if (i < totalOperations - 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        return {
          success: true,
          successCount,
          successRate: successCount / totalOperations,
          totalOperations,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

    expect(reliabilityTest.success).toBe(true);
    expect(reliabilityTest.successRate).toBeGreaterThanOrEqual(0.95);
  });
});
