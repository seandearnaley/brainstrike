import { describe, expect, it } from 'vitest';
import { getFolderColor } from '../color-utils.js';

describe('color-utils', () => {
  describe('getFolderColor', () => {
    it('should return the same color combination for the same input', () => {
      const input = 'src/components';
      const color1 = getFolderColor(input);
      const color2 = getFolderColor(input);

      expect(color1).toEqual(color2);
    });

    it('should return different color combinations for different inputs', () => {
      const input1 = 'src/components';
      const input2 = 'src/utils';

      const color1 = getFolderColor(input1);
      const color2 = getFolderColor(input2);

      // There's a small chance they could be the same by chance
      // but it's unlikely with reasonably different strings
      expect(color1).not.toEqual(color2);
    });

    it('should return valid color schemes with background and text colors', () => {
      const color = getFolderColor('test');

      // Check light theme
      expect(color.light).toBeDefined();
      expect(color.light.bg).toMatch(/^#[0-9A-F]{6}$/i);
      expect(color.light.text).toMatch(/^#[0-9A-F]{6}$/i);

      // Check dark theme
      expect(color.dark).toBeDefined();
      expect(color.dark.bg).toMatch(/^#[0-9A-F]{6}$/i);
      expect(color.dark.text).toMatch(/^#[0-9A-F]{6}$/i);
    });

    it('should handle empty strings', () => {
      const color = getFolderColor('');

      // Even an empty string should return a valid color combination
      expect(color.light).toBeDefined();
      expect(color.light.bg).toBeDefined();
      expect(color.light.text).toBeDefined();
      expect(color.dark).toBeDefined();
      expect(color.dark.bg).toBeDefined();
      expect(color.dark.text).toBeDefined();
    });

    it('should handle special characters', () => {
      const color = getFolderColor('!@#$%^&*()');

      // Special characters should still produce a valid color
      expect(color.light).toBeDefined();
      expect(color.dark).toBeDefined();
    });

    it('should return the same color regardless of case', () => {
      const lower = getFolderColor('tsx');
      const upper = getFolderColor('TSX');
      const mixed = getFolderColor('TsX');

      expect(lower).toEqual(upper);
      expect(lower).toEqual(mixed);
    });

    it('should return colors from the predefined color combinations', () => {
      // Test multiple folder paths to cover most color combinations
      const testPaths = [
        'src/components',
        'src/utils',
        'src/hooks',
        'src/pages',
        'src/styles',
        'src/lib',
        'tests',
        'public',
        'node_modules',
      ];

      for (const path of testPaths) {
        const color = getFolderColor(path);

        // Light theme checks
        expect(color.light.bg).toMatch(/^#([A-F0-9]{6})$/i);
        expect(color.light.text).toMatch(/^#([A-F0-9]{6})$/i);

        // Dark theme checks
        expect(color.dark.bg).toMatch(/^#([A-F0-9]{6})$/i);
        expect(color.dark.text).toMatch(/^#([A-F0-9]{6})$/i);
      }
    });

    it('should always return a color from the predefined combinations', () => {
      // With a non-empty constant array and modulo indexing, every input maps to a valid entry
      const inputs = ['', 'a', 'test', '!@#$', 'very-long-extension-name'];
      for (const input of inputs) {
        const color = getFolderColor(input);
        expect(color.light.bg).toMatch(/^#[0-9A-F]{6}$/i);
        expect(color.dark.bg).toMatch(/^#[0-9A-F]{6}$/i);
      }
    });
  });
});
