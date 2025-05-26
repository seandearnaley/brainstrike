import { test, expect } from '@playwright/test';

test.describe('File Explorer - Filter Functionality', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the File System Access API with a comprehensive file structure for filter testing
    await page.addInitScript(() => {
      /* eslint-disable */
      class FileSystemFileHandle {
        constructor(name) {
          // @ts-expect-error
          this.kind = 'file';
          // @ts-expect-error
          this.name = name;
        }
        async getFile() {
          // @ts-expect-error
          return new File(['test content'], this.name);
        }
      }

      class FileSystemDirectoryHandle {
        constructor(name, entries) {
          // @ts-expect-error
          this.kind = 'directory';
          // @ts-expect-error
          this.name = name;
          // @ts-expect-error
          this._entries = entries;
        }
        async *entries() {
          // @ts-expect-error
          for (const [name, handle] of Object.entries(this._entries)) {
            yield [name, handle];
          }
        }
        async getDirectoryHandle(name) {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'directory') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error('Directory not found');
        }
        async getFileHandle(name) {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'file') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error('File not found');
        }
      }

    // Build a comprehensive fake file tree for filter testing
    const buttonFile = new FileSystemFileHandle('Button.tsx');
    const buttonTestFile = new FileSystemFileHandle('Button.test.tsx');
    const utilsFile = new FileSystemFileHandle('utils.ts');
    const utilsTestFile = new FileSystemFileHandle('utils.test.ts');
    const configFile = new FileSystemFileHandle('config.json');
    const packageFile = new FileSystemFileHandle('package.json');
    const jsFile = new FileSystemFileHandle('legacy.js');
    const jsxFile = new FileSystemFileHandle('OldComponent.jsx');
    
    const myCustomModulesFolder = new FileSystemDirectoryHandle('my_custom_modules', {
      'some-package': new FileSystemDirectoryHandle('some-package', {
        'index.js': new FileSystemFileHandle('index.js'),
      }),
    });
    
    const myCustomCoverageFolder = new FileSystemDirectoryHandle('my_custom_coverage', {
      'lcov.info': new FileSystemFileHandle('lcov.info'),
    });

    const root = new FileSystemDirectoryHandle('test-project', {
      'Button.tsx': buttonFile,
      'Button.test.tsx': buttonTestFile,
      'utils.ts': utilsFile,
      'utils.test.ts': utilsTestFile,
      'config.json': configFile,
      'package.json': packageFile,
      'legacy.js': jsFile,
      'OldComponent.jsx': jsxFile,
      'my_custom_modules': myCustomModulesFolder,
      'my_custom_coverage': myCustomCoverageFolder,
    });

      // @ts-expect-error
      window.showDirectoryPicker = async () => root;
      /* eslint-enable */
    });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select Root' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('No directory selected')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No files selected')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Select Root' }).click();
    
    await expect(page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('No directory selected')).not.toBeVisible();
    await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();
  });

  test('should filter files using text search', async ({ page }) => {
    const fileTree = page.getByRole('tree', { name: 'File tree' });
    const filterInput = page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')");

    // Search for "Button"
    await filterInput.fill('Button');
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Button.test.tsx')).toBeVisible();
    await expect(fileTree.getByText('utils.ts')).not.toBeVisible();
    await expect(fileTree.getByText('package.json')).not.toBeVisible();

    // Clear filter
    await filterInput.fill('');
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('utils.ts')).toBeVisible();

    // Search for ".test"
    await filterInput.fill('.test');
    await expect(fileTree.getByText('Button.test.tsx')).toBeVisible();
    await expect(fileTree.getByText('utils.test.ts')).toBeVisible();
    await expect(fileTree.getByText('Button.tsx')).not.toBeVisible();
    await expect(fileTree.getByText('utils.ts')).not.toBeVisible();

    // Search for "utils -test" (exclude test files)
    await filterInput.fill('utils -test');
    await expect(fileTree.getByText('utils.ts')).toBeVisible();
    await expect(fileTree.getByText('utils.test.ts')).not.toBeVisible();
    await expect(fileTree.getByText('Button.tsx')).not.toBeVisible();
  });
}); 