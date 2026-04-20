import { describe, expect, it } from 'vitest';
import {
  BINARY_FILE_EXTENSIONS,
  EXPAND_COLLAPSE_TEST_ID,
  IGNORED_PATHS,
  MAX_FOLDER_SUMMARY_THRESHOLD,
  MAX_SELECTION_COUNT,
  MIN_FOLDER_SUMMARY_THRESHOLD,
  MIN_MAX_SELECTION_COUNT,
  TEXT_FILE_EXTENSIONS,
} from '../src/file-explorer-constants';

describe('file-explorer-constants', () => {
  describe('TEXT_FILE_EXTENSIONS', () => {
    it('should be defined as an array', () => {
      expect(Array.isArray(TEXT_FILE_EXTENSIONS)).toBe(true);
    });

    it('should contain common programming language extensions', () => {
      const programmingExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go'];
      programmingExtensions.forEach((ext) => {
        expect(TEXT_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain markup and data format extensions', () => {
      const markupExtensions = ['.html', '.xml', '.json', '.yaml', '.yml', '.md'];
      markupExtensions.forEach((ext) => {
        expect(TEXT_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain config file extensions', () => {
      const configExtensions = ['.env', '.gitignore', '.conf', '.ini', '.cfg'];
      configExtensions.forEach((ext) => {
        expect(TEXT_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain stylesheet extensions', () => {
      const stylesheetExtensions = ['.css', '.scss', '.less'];
      stylesheetExtensions.forEach((ext) => {
        expect(TEXT_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain documentation extensions', () => {
      const docExtensions = ['.txt', '.log', '.csv'];
      docExtensions.forEach((ext) => {
        expect(TEXT_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should all start with a period', () => {
      TEXT_FILE_EXTENSIONS.forEach((ext) => {
        expect(ext.startsWith('.')).toBe(true);
      });
    });

    it('should all be lowercase', () => {
      TEXT_FILE_EXTENSIONS.forEach((ext) => {
        expect(ext).toBe(ext.toLowerCase());
      });
    });

    it('should not contain duplicates', () => {
      const uniqueExtensions = [...new Set(TEXT_FILE_EXTENSIONS)];
      expect(uniqueExtensions.length).toBe(TEXT_FILE_EXTENSIONS.length);
    });

    it('should be non-empty', () => {
      expect(TEXT_FILE_EXTENSIONS.length).toBeGreaterThan(0);
    });

    it('should not contain empty strings', () => {
      TEXT_FILE_EXTENSIONS.forEach((ext) => {
        expect(ext.trim()).not.toBe('');
        expect(ext).not.toBe('.');
      });
    });

    it('should not overlap with binary extensions', () => {
      const overlap = TEXT_FILE_EXTENSIONS.filter((ext) => BINARY_FILE_EXTENSIONS.includes(ext));
      expect(overlap).toEqual([]);
    });
  });

  describe('BINARY_FILE_EXTENSIONS', () => {
    it('should be defined as an array', () => {
      expect(Array.isArray(BINARY_FILE_EXTENSIONS)).toBe(true);
    });

    it('should contain common document formats', () => {
      const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
      docExtensions.forEach((ext) => {
        expect(BINARY_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain archive formats', () => {
      const archiveExtensions = ['.zip', '.tar', '.gz', '.7z', '.rar'];
      archiveExtensions.forEach((ext) => {
        expect(BINARY_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain executable formats', () => {
      const executableExtensions = ['.exe', '.dll', '.so', '.dylib'];
      executableExtensions.forEach((ext) => {
        expect(BINARY_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain Java binary formats', () => {
      const javaExtensions = ['.class', '.jar', '.war'];
      javaExtensions.forEach((ext) => {
        expect(BINARY_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain image formats', () => {
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg'];
      imageExtensions.forEach((ext) => {
        expect(BINARY_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain video formats', () => {
      const videoExtensions = ['.mp4', '.avi', '.mov', '.wmv'];
      videoExtensions.forEach((ext) => {
        expect(BINARY_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should contain audio formats', () => {
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.wma'];
      audioExtensions.forEach((ext) => {
        expect(BINARY_FILE_EXTENSIONS).toContain(ext);
      });
    });

    it('should all start with a period', () => {
      BINARY_FILE_EXTENSIONS.forEach((ext) => {
        expect(ext.startsWith('.')).toBe(true);
      });
    });

    it('should all be lowercase', () => {
      BINARY_FILE_EXTENSIONS.forEach((ext) => {
        expect(ext).toBe(ext.toLowerCase());
      });
    });

    it('should not contain duplicates', () => {
      const uniqueExtensions = [...new Set(BINARY_FILE_EXTENSIONS)];
      expect(uniqueExtensions.length).toBe(BINARY_FILE_EXTENSIONS.length);
    });

    it('should be non-empty', () => {
      expect(BINARY_FILE_EXTENSIONS.length).toBeGreaterThan(0);
    });

    it('should not contain empty strings', () => {
      BINARY_FILE_EXTENSIONS.forEach((ext) => {
        expect(ext.trim()).not.toBe('');
        expect(ext).not.toBe('.');
      });
    });
  });

  describe('IGNORED_PATHS', () => {
    it('should be defined as an array', () => {
      expect(Array.isArray(IGNORED_PATHS)).toBe(true);
    });

    it('should contain common version control directories', () => {
      expect(IGNORED_PATHS).toContain('.git');
    });

    it('should contain common dependency directories', () => {
      expect(IGNORED_PATHS).toContain('node_modules');
    });

    it('should contain common build directories', () => {
      const buildDirs = ['dist', 'build', '.next'];
      buildDirs.forEach((dir) => {
        expect(IGNORED_PATHS).toContain(dir);
      });
    });

    it('should contain OS-specific files', () => {
      expect(IGNORED_PATHS).toContain('.DS_Store');
    });

    it('should not contain duplicates', () => {
      const uniquePaths = [...new Set(IGNORED_PATHS)];
      expect(uniquePaths.length).toBe(IGNORED_PATHS.length);
    });

    it('should be non-empty', () => {
      expect(IGNORED_PATHS.length).toBeGreaterThan(0);
    });

    it('should not contain empty strings', () => {
      IGNORED_PATHS.forEach((path) => {
        expect(path.trim()).not.toBe('');
      });
    });

    it('should not contain absolute paths', () => {
      IGNORED_PATHS.forEach((path) => {
        expect(path.startsWith('/')).toBe(false);
        expect(path.startsWith('C:')).toBe(false);
        expect(path.startsWith('~')).toBe(false);
      });
    });
  });

  describe('MIN_FOLDER_SUMMARY_THRESHOLD', () => {
    it('should be defined as a number', () => {
      expect(typeof MIN_FOLDER_SUMMARY_THRESHOLD).toBe('number');
    });

    it('should be 0', () => {
      expect(MIN_FOLDER_SUMMARY_THRESHOLD).toBe(0);
    });

    it('should be non-negative', () => {
      expect(MIN_FOLDER_SUMMARY_THRESHOLD).toBeGreaterThanOrEqual(0);
    });

    it('should be less than MAX_FOLDER_SUMMARY_THRESHOLD', () => {
      expect(MIN_FOLDER_SUMMARY_THRESHOLD).toBeLessThan(MAX_FOLDER_SUMMARY_THRESHOLD);
    });

    it('should be an integer', () => {
      expect(Number.isInteger(MIN_FOLDER_SUMMARY_THRESHOLD)).toBe(true);
    });
  });

  describe('MAX_FOLDER_SUMMARY_THRESHOLD', () => {
    it('should be defined as a number', () => {
      expect(typeof MAX_FOLDER_SUMMARY_THRESHOLD).toBe('number');
    });

    it('should be 1000', () => {
      expect(MAX_FOLDER_SUMMARY_THRESHOLD).toBe(1000);
    });

    it('should be positive', () => {
      expect(MAX_FOLDER_SUMMARY_THRESHOLD).toBeGreaterThan(0);
    });

    it('should be greater than MIN_FOLDER_SUMMARY_THRESHOLD', () => {
      expect(MAX_FOLDER_SUMMARY_THRESHOLD).toBeGreaterThan(MIN_FOLDER_SUMMARY_THRESHOLD);
    });

    it('should be an integer', () => {
      expect(Number.isInteger(MAX_FOLDER_SUMMARY_THRESHOLD)).toBe(true);
    });

    it('should allow reasonable folder sizes', () => {
      expect(MAX_FOLDER_SUMMARY_THRESHOLD).toBeGreaterThan(100);
    });
  });

  describe('MIN_MAX_SELECTION_COUNT', () => {
    it('should be defined as a number', () => {
      expect(typeof MIN_MAX_SELECTION_COUNT).toBe('number');
    });

    it('should be 1', () => {
      expect(MIN_MAX_SELECTION_COUNT).toBe(1);
    });

    it('should be positive', () => {
      expect(MIN_MAX_SELECTION_COUNT).toBeGreaterThan(0);
    });

    it('should be less than or equal to MAX_SELECTION_COUNT', () => {
      expect(MIN_MAX_SELECTION_COUNT).toBeLessThanOrEqual(MAX_SELECTION_COUNT);
    });

    it('should be an integer', () => {
      expect(Number.isInteger(MIN_MAX_SELECTION_COUNT)).toBe(true);
    });

    it('should allow at least one selection', () => {
      expect(MIN_MAX_SELECTION_COUNT).toBeGreaterThanOrEqual(1);
    });
  });

  describe('MAX_SELECTION_COUNT', () => {
    it('should be defined as a number', () => {
      expect(typeof MAX_SELECTION_COUNT).toBe('number');
    });

    it('should be 10000', () => {
      expect(MAX_SELECTION_COUNT).toBe(10_000);
    });

    it('should be positive', () => {
      expect(MAX_SELECTION_COUNT).toBeGreaterThan(0);
    });

    it('should be greater than MIN_MAX_SELECTION_COUNT', () => {
      expect(MAX_SELECTION_COUNT).toBeGreaterThan(MIN_MAX_SELECTION_COUNT);
    });

    it('should be an integer', () => {
      expect(Number.isInteger(MAX_SELECTION_COUNT)).toBe(true);
    });

    it('should allow reasonable selection sizes', () => {
      expect(MAX_SELECTION_COUNT).toBeGreaterThan(10);
    });
  });

  describe('EXPAND_COLLAPSE_TEST_ID', () => {
    it('should be defined as a string', () => {
      expect(typeof EXPAND_COLLAPSE_TEST_ID).toBe('string');
    });

    it('should be "expand-collapse-button"', () => {
      expect(EXPAND_COLLAPSE_TEST_ID).toBe('expand-collapse-button');
    });

    it('should not be empty', () => {
      expect(EXPAND_COLLAPSE_TEST_ID.trim()).not.toBe('');
    });

    it('should be lowercase with hyphens', () => {
      expect(EXPAND_COLLAPSE_TEST_ID).toMatch(/^[a-z-]+$/);
    });

    it('should not contain spaces', () => {
      expect(EXPAND_COLLAPSE_TEST_ID).not.toContain(' ');
    });

    it('should be a valid HTML id', () => {
      // HTML ids should not start with a digit
      expect(/^[a-zA-Z]/.test(EXPAND_COLLAPSE_TEST_ID)).toBe(true);
    });
  });

  describe('constant relationships', () => {
    it('should have consistent threshold ranges', () => {
      const thresholdRange = MAX_FOLDER_SUMMARY_THRESHOLD - MIN_FOLDER_SUMMARY_THRESHOLD;
      expect(thresholdRange).toBeGreaterThan(0);
    });

    it('should have consistent selection count ranges', () => {
      const selectionRange = MAX_SELECTION_COUNT - MIN_MAX_SELECTION_COUNT;
      expect(selectionRange).toBeGreaterThan(0);
    });

    it('should not have overlapping file classifications', () => {
      const binarySet = new Set(BINARY_FILE_EXTENSIONS);

      TEXT_FILE_EXTENSIONS.forEach((ext) => {
        expect(binarySet.has(ext)).toBe(false);
      });
    });

    it('should have valid numeric bounds for validation', () => {
      const testThreshold = 500;
      const isValidThreshold =
        testThreshold >= MIN_FOLDER_SUMMARY_THRESHOLD &&
        testThreshold <= MAX_FOLDER_SUMMARY_THRESHOLD;
      expect(isValidThreshold).toBe(true);

      const testSelection = 50;
      const isValidSelection =
        testSelection >= MIN_MAX_SELECTION_COUNT && testSelection <= MAX_SELECTION_COUNT;
      expect(isValidSelection).toBe(true);
    });
  });

  describe('practical usage', () => {
    it('should allow checking if a file is text', () => {
      const isText = (filename: string) => {
        const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
        return TEXT_FILE_EXTENSIONS.includes(ext);
      };

      expect(isText('example.ts')).toBe(true);
      expect(isText('example.json')).toBe(true);
      expect(isText('example.unknown')).toBe(false);
    });

    it('should allow checking if a file is binary', () => {
      const isBinary = (filename: string) => {
        const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
        return BINARY_FILE_EXTENSIONS.includes(ext);
      };

      expect(isBinary('document.pdf')).toBe(true);
      expect(isBinary('image.png')).toBe(true);
      expect(isBinary('script.ts')).toBe(false);
    });

    it('should allow checking if a path should be ignored', () => {
      const shouldIgnore = (pathSegment: string) =>
        IGNORED_PATHS.some((ignored) => pathSegment.includes(ignored));

      expect(shouldIgnore('project/node_modules/package')).toBe(true);
      expect(shouldIgnore('project/.git/config')).toBe(true);
      expect(shouldIgnore('project/src/index.ts')).toBe(false);
    });

    it('should allow validating folder summary threshold', () => {
      const validateThreshold = (value: number) =>
        Number.isInteger(value) &&
        value >= MIN_FOLDER_SUMMARY_THRESHOLD &&
        value <= MAX_FOLDER_SUMMARY_THRESHOLD;

      expect(validateThreshold(500)).toBe(true);
      expect(validateThreshold(-1)).toBe(false);
      expect(validateThreshold(2000)).toBe(false);
      expect(validateThreshold(500.5)).toBe(false);
    });

    it('should allow validating selection count', () => {
      const validateSelectionCount = (value: number) =>
        Number.isInteger(value) && value >= MIN_MAX_SELECTION_COUNT && value <= MAX_SELECTION_COUNT;

      expect(validateSelectionCount(50)).toBe(true);
      expect(validateSelectionCount(0)).toBe(false);
      expect(validateSelectionCount(20_000)).toBe(false);
      expect(validateSelectionCount(50.5)).toBe(false);
    });
  });
});
