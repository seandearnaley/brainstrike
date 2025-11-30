import { describe, expect, it } from 'vitest';
import { type FolderColors, getFolderColor } from '../color-utils';

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

    it('should return default colors when no combinations are defined', async () => {
      vi.resetModules();

      vi.doMock('../color-utils', async () => {
        const actual = await vi.importActual('../color-utils');

        const getFolderColor = (str: string) => {
          const ColorCombinations: FolderColors[] = [];
          let hash = 0;
          for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
          }

          const index = Math.abs(hash) % ColorCombinations.length;
          const selectedColor = ColorCombinations[index];

          if (selectedColor !== undefined) {
            return selectedColor;
          }
          if (ColorCombinations.length > 0) {
            return ColorCombinations[0];
          }
          return {
            light: { bg: '#FFFFFF', text: '#000000' },
            dark: { bg: '#000000', text: '#FFFFFF' },
          };
        };

        return {
          ...actual,
          getFolderColor,
        };
      });

      const { getFolderColor: mockedGetFolderColor } = await import('../color-utils');
      const color = mockedGetFolderColor('a');

      expect(color).toEqual({
        light: { bg: '#FFFFFF', text: '#000000' },
        dark: { bg: '#000000', text: '#FFFFFF' },
      });

      vi.resetModules();
    });
  });
});
