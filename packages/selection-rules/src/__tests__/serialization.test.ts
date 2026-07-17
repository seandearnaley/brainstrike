import { describe, expect, it } from 'vitest';
import type { ExplicitRule, MaterializedSelection, SelectionRuleSet } from '../schema';
import { createEmptyMaterializedSelection, createEmptyRuleSet } from '../schema';
import {
  cloneMaterializedSelectionThroughSerialization,
  cloneRuleSetThroughSerialization,
  deserializeMaterializedSelection,
  deserializeRuleSet,
  safeDeserializeMaterializedSelection,
  safeDeserializeRuleSet,
  serializeMaterializedSelection,
  serializeRuleSet,
  validateAndNormalizeRuleSet,
} from '../serialization';

describe('serialization', () => {
  const sampleRule: ExplicitRule = {
    createdAt: '2026-01-02T00:00:00.000Z',
    enabled: true,
    id: 'rule-1',
    label: 'Main files',
    paths: ['src/index.ts', 'src/utils.ts'],
    type: 'explicit',
  };

  const sampleRuleSet: SelectionRuleSet = {
    folderId: 'folder-123',
    metadata: {
      createdAt: '2026-01-02T00:00:00.000Z',
      description: 'Test rule set',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    rules: [sampleRule],
    version: 1,
  };

  const sampleMaterializedSelection: MaterializedSelection = {
    appliedRules: ['rule-1', 'rule-2'],
    capped: false,
    materializedAt: '2026-01-02T12:00:00.000Z',
    originalCount: 3,
    paths: new Set(['src/index.ts', 'src/utils.ts', 'src/helpers.ts']),
    warnings: [
      {
        code: 'pattern-no-match',
        message: 'Pattern **/*.test.ts matched no files',
        ruleId: 'rule-3',
      },
    ],
  };

  describe('serializeRuleSet / deserializeRuleSet', () => {
    it('should serialize rule set to JSON string', () => {
      const json = serializeRuleSet(sampleRuleSet);

      expect(typeof json).toBe('string');
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should deserialize valid JSON back to rule set', () => {
      const json = serializeRuleSet(sampleRuleSet);
      const deserialized = deserializeRuleSet(json);

      expect(deserialized).toEqual(sampleRuleSet);
    });

    it('should throw for invalid JSON syntax', () => {
      expect(() => deserializeRuleSet('not json')).toThrow('Failed to parse JSON');
    });

    it('should throw for invalid rule set structure', () => {
      const invalidJson = JSON.stringify({ version: 2 });
      expect(() => deserializeRuleSet(invalidJson)).toThrow();
    });

    it('should throw for rule set with invalid rules', () => {
      const invalidRuleSet = {
        ...sampleRuleSet,
        rules: [{ type: 'invalid' }],
      };
      const json = JSON.stringify(invalidRuleSet);
      expect(() => deserializeRuleSet(json)).toThrow();
    });
  });

  describe('safeDeserializeRuleSet', () => {
    it('should return deserialized rule set for valid input', () => {
      const json = serializeRuleSet(sampleRuleSet);
      const result = safeDeserializeRuleSet(json, 'fallback-folder');

      expect(result).toEqual(sampleRuleSet);
    });

    it('should return empty rule set for invalid JSON', () => {
      const result = safeDeserializeRuleSet('invalid json', 'fallback-folder');

      expect(result.version).toBe(1);
      expect(result.folderId).toBe('fallback-folder');
      expect(result.rules).toEqual([]);
    });

    it('should return empty rule set for invalid structure', () => {
      const result = safeDeserializeRuleSet('{"version": 999}', 'fallback-folder');

      expect(result.folderId).toBe('fallback-folder');
      expect(result.rules).toEqual([]);
    });
  });

  describe('serializeMaterializedSelection / deserializeMaterializedSelection', () => {
    it('should serialize materialized selection to JSON string', () => {
      const json = serializeMaterializedSelection(sampleMaterializedSelection);

      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      // paths should be array, not Set
      expect(Array.isArray(parsed.paths)).toBe(true);
    });

    it('should convert Set to array during serialization', () => {
      const json = serializeMaterializedSelection(sampleMaterializedSelection);
      const parsed = JSON.parse(json);

      expect(parsed.paths).toEqual(['src/index.ts', 'src/utils.ts', 'src/helpers.ts']);
    });

    it('should deserialize and convert array back to Set', () => {
      const json = serializeMaterializedSelection(sampleMaterializedSelection);
      const deserialized = deserializeMaterializedSelection(json);

      expect(deserialized.paths).toBeInstanceOf(Set);
      expect(deserialized.paths.size).toBe(3);
      expect(deserialized.paths.has('src/index.ts')).toBe(true);
    });

    it('should preserve all fields during round-trip', () => {
      const json = serializeMaterializedSelection(sampleMaterializedSelection);
      const deserialized = deserializeMaterializedSelection(json);

      expect(deserialized.appliedRules).toEqual(sampleMaterializedSelection.appliedRules);
      expect(deserialized.capped).toBe(sampleMaterializedSelection.capped);
      expect(deserialized.originalCount).toBe(sampleMaterializedSelection.originalCount);
      expect(deserialized.warnings).toEqual(sampleMaterializedSelection.warnings);
      expect(deserialized.materializedAt).toBe(sampleMaterializedSelection.materializedAt);
    });

    it('should throw for invalid JSON syntax', () => {
      expect(() => deserializeMaterializedSelection('not json')).toThrow('Failed to parse JSON');
    });

    it('should throw for invalid structure', () => {
      const invalidJson = JSON.stringify({ paths: 'not-an-array' });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    // Type guard validation tests - each tests a specific condition
    it('should throw when paths array contains non-strings', () => {
      const invalidJson = JSON.stringify({
        appliedRules: [],
        capped: false,
        materializedAt: '2026-01-02T00:00:00.000Z',
        originalCount: 0,
        paths: ['valid.ts', 123, 'another.ts'], // 123 is not a string
        warnings: [],
      });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw when appliedRules is not an array', () => {
      const invalidJson = JSON.stringify({
        appliedRules: 'not-an-array',
        capped: false,
        materializedAt: '2026-01-02T00:00:00.000Z',
        originalCount: 0,
        paths: [],
        warnings: [],
      });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw when capped is not a boolean', () => {
      const invalidJson = JSON.stringify({
        appliedRules: [],
        capped: 'false', // string instead of boolean
        materializedAt: '2026-01-02T00:00:00.000Z',
        originalCount: 0,
        paths: [],
        warnings: [],
      });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw when originalCount is not a number', () => {
      const invalidJson = JSON.stringify({
        appliedRules: [],
        capped: false,
        materializedAt: '2026-01-02T00:00:00.000Z',
        originalCount: '0', // string instead of number
        paths: [],
        warnings: [],
      });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw when warnings is not an array', () => {
      const invalidJson = JSON.stringify({
        appliedRules: [],
        capped: false,
        materializedAt: '2026-01-02T00:00:00.000Z',
        originalCount: 0,
        paths: [],
        warnings: {}, // object instead of array
      });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw when materializedAt is not a string', () => {
      const invalidJson = JSON.stringify({
        appliedRules: [],
        capped: false,
        materializedAt: 12_345, // number instead of string
        originalCount: 0,
        paths: [],
        warnings: [],
      });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw when paths property is missing', () => {
      const invalidJson = JSON.stringify({
        appliedRules: [],
        capped: false,
        materializedAt: '2026-01-02T00:00:00.000Z',
        originalCount: 0,
        warnings: [],
      });
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw for null input after parsing', () => {
      const invalidJson = 'null';
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });

    it('should throw for primitive parsed value', () => {
      const invalidJson = '"just a string"';
      expect(() => deserializeMaterializedSelection(invalidJson)).toThrow(
        'Invalid materialized selection'
      );
    });
  });

  describe('safeDeserializeMaterializedSelection', () => {
    it('should return deserialized selection for valid input', () => {
      const json = serializeMaterializedSelection(sampleMaterializedSelection);
      const result = safeDeserializeMaterializedSelection(json);

      expect(result.paths.size).toBe(3);
    });

    it('should return empty selection for invalid JSON', () => {
      const result = safeDeserializeMaterializedSelection('invalid json');

      expect(result.paths.size).toBe(0);
      expect(result.appliedRules).toEqual([]);
      expect(result.capped).toBe(false);
    });

    it('should return empty selection for invalid structure', () => {
      const result = safeDeserializeMaterializedSelection('{"invalid": true}');

      expect(result.paths.size).toBe(0);
    });
  });

  describe('validateAndNormalizeRuleSet', () => {
    it('should return success for valid rule set', () => {
      const result = validateAndNormalizeRuleSet(sampleRuleSet);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(sampleRuleSet);
      }
    });

    it('should return errors for invalid rule set', () => {
      const result = validateAndNormalizeRuleSet({ version: 999 });

      expect(result.success).toBe(false);
    });
  });

  describe('Round-trip tests', () => {
    describe('cloneRuleSetThroughSerialization', () => {
      it('should create deep clone with identical data', () => {
        const clone = cloneRuleSetThroughSerialization(sampleRuleSet);

        expect(clone).toEqual(sampleRuleSet);
        expect(clone).not.toBe(sampleRuleSet);
        expect(clone.rules).not.toBe(sampleRuleSet.rules);
        expect(clone.metadata).not.toBe(sampleRuleSet.metadata);
      });

      it('should handle empty rule set', () => {
        const empty = createEmptyRuleSet('test-folder');
        const clone = cloneRuleSetThroughSerialization(empty);

        expect(clone.version).toBe(1);
        expect(clone.folderId).toBe('test-folder');
        expect(clone.rules).toEqual([]);
      });

      it('should preserve all rule types through round-trip', () => {
        const complexRuleSet: SelectionRuleSet = {
          folderId: 'complex-folder',
          metadata: {
            createdAt: '2026-01-02T00:00:00.000Z',
            description: 'Complex test',
            migratedFrom: 'explicit-set',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          rules: [
            {
              createdAt: '2026-01-02T00:00:00.000Z',
              id: 'r1',
              mode: 'include',
              paths: ['a.ts', 'b.ts'],
              type: 'explicit',
            },
            {
              basePath: 'src',
              createdAt: '2026-01-02T00:00:00.000Z',
              id: 'r2',
              patterns: ['**/*.ts', '**/*.tsx'],
              type: 'glob-include',
            },
            {
              createdAt: '2026-01-02T00:00:00.000Z',
              id: 'r3',
              patterns: ['**/*.test.ts'],
              type: 'glob-exclude',
            },
            {
              createdAt: '2026-01-02T00:00:00.000Z',
              id: 'r4',
              maxDepth: 3,
              roots: ['src', 'lib'],
              type: 'root-include',
            },
            {
              createdAt: '2026-01-02T00:00:00.000Z',
              id: 'r5',
              roots: ['node_modules'],
              type: 'root-exclude',
            },
            {
              createdAt: '2026-01-02T00:00:00.000Z',
              id: 'r6',
              maxCount: 100,
              seed: 42,
              strategy: 'priority',
              type: 'cap',
            },
          ],
          version: 1,
        };

        const clone = cloneRuleSetThroughSerialization(complexRuleSet);

        expect(clone).toEqual(complexRuleSet);
        expect(clone.rules).toHaveLength(6);
      });
    });

    describe('cloneMaterializedSelectionThroughSerialization', () => {
      it('should create deep clone with Set preserved', () => {
        const clone = cloneMaterializedSelectionThroughSerialization(sampleMaterializedSelection);

        expect(clone.paths).toBeInstanceOf(Set);
        expect(clone.paths.size).toBe(sampleMaterializedSelection.paths.size);
        expect(clone.paths).not.toBe(sampleMaterializedSelection.paths);
      });

      it('should handle empty selection', () => {
        const empty = createEmptyMaterializedSelection();
        const clone = cloneMaterializedSelectionThroughSerialization(empty);

        expect(clone.paths.size).toBe(0);
        expect(clone.appliedRules).toEqual([]);
        expect(clone.capped).toBe(false);
      });

      it('should preserve warning details', () => {
        const selectionWithWarnings: MaterializedSelection = {
          appliedRules: ['r1'],
          capped: true,
          materializedAt: '2026-01-02T00:00:00.000Z',
          originalCount: 150,
          paths: new Set(['file.ts']),
          warnings: [
            { code: 'cap-applied', message: 'Cap reduced 150 to 100', ruleId: 'cap-1' },
            { code: 'root-not-found', message: 'Root /missing not found' },
          ],
        };

        const clone = cloneMaterializedSelectionThroughSerialization(selectionWithWarnings);

        expect(clone.warnings).toHaveLength(2);
        expect(clone.warnings[0]).toEqual(selectionWithWarnings.warnings[0]);
        expect(clone.warnings[1]).toEqual(selectionWithWarnings.warnings[1]);
      });
    });

    describe('serialize → parse → equals pattern', () => {
      it('should maintain equality after full round-trip for rule set', () => {
        const json = serializeRuleSet(sampleRuleSet);
        const parsed = deserializeRuleSet(json);
        const json2 = serializeRuleSet(parsed);
        const parsed2 = deserializeRuleSet(json2);

        // Compare parsed objects (JSON property order may differ)
        expect(parsed).toEqual(sampleRuleSet);
        expect(parsed2).toEqual(parsed);
      });

      it('should maintain equality after full round-trip for materialized selection', () => {
        const json = serializeMaterializedSelection(sampleMaterializedSelection);
        const parsed = deserializeMaterializedSelection(json);
        const json2 = serializeMaterializedSelection(parsed);
        const parsed2 = deserializeMaterializedSelection(json2);

        // Compare parsed objects
        expect(parsed.paths).toEqual(sampleMaterializedSelection.paths);
        expect(parsed2.paths).toEqual(parsed.paths);
      });

      it('should handle multiple consecutive round-trips', () => {
        let current = sampleRuleSet;

        for (let i = 0; i < 10; i++) {
          const json = serializeRuleSet(current);
          current = deserializeRuleSet(json);
        }

        expect(current).toEqual(sampleRuleSet);
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle rule set with unicode in paths', () => {
      const unicodeRuleSet: SelectionRuleSet = {
        folderId: 'folder-café',
        metadata: {
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        rules: [
          {
            createdAt: '2026-01-02T00:00:00.000Z',
            id: 'r1',
            paths: ['日本語/ファイル.ts', 'émoji/🎉.js'],
            type: 'explicit',
          },
        ],
        version: 1,
      };

      const json = serializeRuleSet(unicodeRuleSet);
      const parsed = deserializeRuleSet(json);

      expect(parsed.rules[0].type).toBe('explicit');
      if (parsed.rules[0].type === 'explicit') {
        expect(parsed.rules[0].paths).toContain('日本語/ファイル.ts');
        expect(parsed.rules[0].paths).toContain('émoji/🎉.js');
      }
    });

    it('should handle materialized selection with empty paths', () => {
      const emptyPaths: MaterializedSelection = {
        appliedRules: [],
        capped: false,
        materializedAt: '2026-01-02T00:00:00.000Z',
        originalCount: 0,
        paths: new Set(),
        warnings: [],
      };

      const json = serializeMaterializedSelection(emptyPaths);
      const parsed = deserializeMaterializedSelection(json);

      expect(parsed.paths.size).toBe(0);
    });

    it('should handle rule set with very long paths', () => {
      const longPath = `${'a/'.repeat(100)}file.ts`;
      const ruleSet: SelectionRuleSet = {
        folderId: 'folder',
        metadata: {
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        rules: [
          {
            createdAt: '2026-01-02T00:00:00.000Z',
            id: 'r1',
            paths: [longPath],
            type: 'explicit',
          },
        ],
        version: 1,
      };

      const clone = cloneRuleSetThroughSerialization(ruleSet);

      expect(clone.rules[0].type).toBe('explicit');
      if (clone.rules[0].type === 'explicit') {
        expect(clone.rules[0].paths[0]).toBe(longPath);
      }
    });
  });
});
