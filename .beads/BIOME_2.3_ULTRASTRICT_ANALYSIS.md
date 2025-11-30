# Biome 2.3 Ultrastrict Configuration Analysis

**Date:** November 30, 2025  
**Status:** Primary Analysis Complete  
**Scope:** Turborepo Monorepo Configuration Migration

---

## Executive Summary

Upgrading the brainstrike monorepo to use **maximum strictness configuration** with Biome 2.3 to enforce highest code quality standards across all packages and apps. This analysis confirms feasibility, identifies implementation scope, and documents required changes.

### Key Finding
**No formal "ultrastrict" preset exists in Biome 2.3.** However, we can achieve equivalent strictness by:
- Enabling all available linting rules and setting them to `"error"` severity
- Customizing existing overrides to align with stricter standards
- Leveraging new rules introduced in Biome 2.1+ that are currently not fully utilized

---

## Current State

### Biome Version
- **Current:** `@biomejs/biome: 2.3.8` (already installed)
- **Latest Available:** 2.3.x (November 2025)
- **Latest Minor:** 2.1.0 (introduced new features like light scanner, better type inference)

### Current Configuration Analysis

**File:** `biome.json` (318 lines)

**Enabled Rules:**
- ✅ **Correctness Rules (7 rules):** `noUnusedVariables`, `noUnusedImports`, `noUndeclaredVariables`, `noUnusedFunctionParameters`, `useValidForDirection`, `useYield`, `noUnreachable`, `useHookAtTopLevel`, `noReactPropAssignments`
- ✅ **Suspicious Rules (4 rules):** `noExplicitAny`, `noDebugger`, `noDuplicateParameters`, `noConsole`
- ✅ **Style Rules (15+ rules):** `useConst`, `noInferrableTypes`, `useNodejsImportProtocol`, `noParameterAssign`, `useAsConstAssertion`, `useDefaultParameterLast`, `useEnumInitializers`, `useSelfClosingElements`, `useSingleVarDeclarator`, `noUnusedTemplateLiteral`, `useNumberNamespace`, `noUselessElse`, `useNamingConvention`, `useFilenamingConvention`
- ✅ **Complexity Rules (3 rules):** `noExcessiveCognitiveComplexity`, `noUselessCatch`, `noUselessConstructor`
- ✅ **Performance Rules (1 rule):** `noDelete`
- ✅ **Security Rules (1 rule):** `noDangerouslySetInnerHtml`
- ✅ **Nursery Rules (1 rule):** `noFloatingPromises`

**Disabled/Relaxed Rules:**
- ❌ Accessibility rules (a11y) - **None explicitly configured**
- ❌ Many style rules not configured
- ❌ Many correctness rules not configured
- ❌ Various performance/optimization rules not enabled

**Current Overrides:** 8 overrides for specific paths and file patterns

---

## Available Biome 2.3 Rule Categories

Based on official Biome documentation, these categories are available:

### 1. **Accessibility (a11y)** — 34 rules
Examples: `noAccessKey`, `noAriaHiddenOnFocusable`, `noBlankTarget`, `noPositiveTabindex`, `useAltText`, `useButtonType`, `useHeadingContent`, `useHtmlLang`, `useIframeTitle`, `useKeyWithClickEvents`, `useMediaCaption`, `useSemanticElements`, `useValidAriaProps`, `useValidAriaRole`, `useValidLang`

### 2. **Correctness** — Multiple rules
Currently enabled: `noUnusedVariables`, `noUnusedImports`, `noUndeclaredVariables`, `noUnusedFunctionParameters`, `useValidForDirection`, `useYield`, `noUnreachable`, `useHookAtTopLevel`, `noReactPropAssignments`

**Not yet configured:** `noArrayIndexKey`, `noChildrenProp`, `noConstAssign`, `noDuplicateKeys`, `noImplicitAny`, `noImplicitBoolean`, `noParameterProperties`, `noRenderReturnValue`, `useExhaustiveDependencies`, `useValidForDirection`, `useNestedComponentDefinitions`, `noEmptyPattern`, `useParseIntRadix`, `useUniqueElementIds`

### 3. **Suspicious** — Multiple rules
Currently enabled: `noExplicitAny`, `noDebugger`, `noDuplicateParameters`, `noConsole`

**Not yet configured:** `noAssignInExpressions`, `noAsyncPromiseExecutor`, `noCaseSensitiveCompare`, `noClassAssign`, `noColorWithoutColorFunction`, `noDeleteOperator`, `noDuplicateJsxProps`, `noDuplicateObjectKeys`, `noFunctionAssign`, `noGlobalAssign`, `noImplicitBoolean`, `noInvalidConstructorSuper`, `noMisleadingCharacterClass`, `noMisleadingInstantiator`, `noMissingSuperCall`, `noNonNullAssertion`, `noNonNullAssertedOptionalChain`, `noPrototypeBuiltins`, `noRedeclare`, `noSelfCompare`, `noShadowRestrictedNames`, `noUnsafeDeclarationMerging`, `noUnsafeFinally`, `noUnsafeNegation`, `noUnsafeOptionalChainingOnConstant`, `noVar`, `useAwait`, `useValidTypeof`

### 4. **Style** — Multiple rules
Currently enabled: ~15 rules

**Not yet configured:** `noArguments`, `noCommaOperator`, `noCommentsInCodeBlocks`, `noDefaultExport`, `noDuplicateImports`, `noEmptyBlockStatements`, `noIndexSignature`, `noInferrable types`, `noLabelVar`, `noMultipleSpacesInRegularExpressionLiterals`, `noNonNullAssertion`, `noRestrictedGlobals`, `noUnnecessaryElse`, `noUnnecessaryFragments`, `noUnusedTemplateLiteral`, `noVar`, `useAsConstAssertion`, `useBlockStatements`, `useCollapsedElseIf`, `useConsistentArrayType`, `useConsistentMemberAccessibility`, `useConsistentNewlines`, `useConsistentQuoteStyle`, `useDefaultSwitchClauseLast`, `useExponentiationOperator`, `useExplicitLengthCheck`, `useFilenamingConvention`, `useLogicalAssignment`, `useNamingConvention`, `useNodejsImportProtocol`, `useNumberNamespace`, `useNumericLiterals`, `useObjectShorthandProperties`, `usePlatformLog`, `useQuoteProps`, `useShorthandAssignments`, `useSelfClosingElements`, `useSingleCaseStatement`, `useSingleVarDeclarator`, `useTemplate`, `useToLocaleString`, `useToString`, `useTrimStartEnd`, `useWhile`

### 5. **Complexity** — Multiple rules
Currently enabled: 3 rules

**Not yet configured:** `noBannedTypes`, `noExcessiveComplexity`, `noBannedTypes`, `useSimplifiedLogicalExpression`

### 6. **Performance** — Multiple rules
Currently enabled: 1 rule (`noDelete`)

**Not yet configured:** `noAccumulatingSpread`, `noBarrelFile`, `noBarrelFileExt`, `noBarrelFileImportIndex`, `noBarrelFileRelativePath`

### 7. **Security** — Multiple rules
Currently enabled: 1 rule (`noDangerouslySetInnerHtml`)

**Not yet configured:** `noDangerouslySetInnerHtml`, `noGlobalEval`, `noImplicitAnyLet`

### 8. **Nursery** — Experimental/New Rules
Currently enabled: 1 rule (`noFloatingPromises`)

**Not yet configured:** Multiple experimental rules awaiting stabilization

---

## Migration Path

### Phase 1: Preparation
1. **Version Check:** Confirm Biome 2.3.8 is appropriate or upgrade if needed
2. **Backup:** Save current `biome.json` for comparison
3. **Understand Impact:** Run analysis to identify all files that will be affected

### Phase 2: Implementation (This Ticket)
1. **Create `biome.json.ultrastrict`** — New configuration with all rules enabled at `"error"` severity
2. **Enable Additional Rule Categories:**
   - Accessibility rules (a11y) - all rules to `"error"`
   - Additional style rules
   - Additional correctness rules
   - Performance optimization rules
   - Security rules
3. **Refine Overrides** — Update path-specific overrides to align with stricter standards
4. **Test Configuration** — Run `biome check` to identify violations

### Phase 3: Remediation (Future Ticket)
1. **Fix Code Violations** — Address all linting errors introduced
2. **Update Overrides** — Fine-tune exclusions where necessary (e.g., test files, generated code)
3. **Run Full Suite** — `pnpm check` to ensure build, lint, type-check, test all pass
4. **Merge & Deploy** — Create PR, get approval, merge to main

---

## Proposed Ultrastrict Configuration Structure

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/2.3.8/schema.json",
  "files": {
    // Keep existing includes/excludes
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      
      // ACCESSIBILITY (a11y) - All enabled
      "a11y": {
        // ~34 rules
        "noAccessKey": "error",
        "noAriaHiddenOnFocusable": "error",
        "noAriaUnsupportedElements": "error",
        "noAutofocus": "error",
        "noBlankTarget": "error",
        "noDistractingElements": "error",
        "noHeaderScope": "error",
        "noInteractiveElementToNoninteractiveRole": "error",
        "noLabelWithoutControl": "error",
        "noNoninteractiveElementToInteractiveRole": "error",
        "noNoninteractiveTabindex": "error",
        "noPositiveTabindex": "error",
        "noRedundantAlt": "error",
        "noRedundantRoles": "error",
        "noSvgWithoutTitle": "error",
        "useAltText": "error",
        "useAnchorContent": "error",
        "useAriaActivedescendantWithTabindex": "error",
        "useAriaPropsForRole": "error",
        "useButtonType": "error",
        "useFocusableInteractive": "error",
        "useGenericFontNames": "error",
        "useHeadingContent": "error",
        "useHtmlLang": "error",
        "useIframeTitle": "error",
        "useKeyWithClickEvents": "error",
        "useKeyWithMouseEvents": "error",
        "useMediaCaption": "error",
        "useSemanticElements": "error",
        "useValidAnchor": "error",
        "useValidAriaProps": "error",
        "useValidAriaRole": "error",
        "useValidAriaValues": "error",
        "useValidLang": "error"
      },

      // CORRECTNESS - Expand significantly
      "correctness": {
        // Current rules (keep as is)
        "noUnusedVariables": "error",
        "noUnusedImports": "error",
        "noUndeclaredVariables": "error",
        "noUnusedFunctionParameters": "error",
        "useValidForDirection": "error",
        "useYield": "error",
        "noUnreachable": "error",
        "useHookAtTopLevel": "error",
        "noReactPropAssignments": "error",
        
        // Additional rules
        "noArrayIndexKey": "error",
        "noChildrenProp": "error",
        "noConstAssign": "error",
        "noDuplicateKeys": "error",
        "noParameterProperties": "error",
        "noRenderReturnValue": "error",
        "useExhaustiveDependencies": "error",
        "useNestedComponentDefinitions": "error",
        "noEmptyPattern": "error",
        "useParseIntRadix": "error",
        "useUniqueElementIds": "error"
      },

      // SUSPICIOUS - Expand
      "suspicious": {
        // Current rules
        "noExplicitAny": "error",
        "noDebugger": "error",
        "noDuplicateParameters": "error",
        "noConsole": "error",
        
        // Additional rules
        "noAssignInExpressions": "error",
        "noAsyncPromiseExecutor": "error",
        "noCaseSensitiveCompare": "error",
        "noClassAssign": "error",
        "noDuplicateJsxProps": "error",
        "noDuplicateObjectKeys": "error",
        "noFunctionAssign": "error",
        "noGlobalAssign": "error",
        "noMissingSuperCall": "error",
        "noNonNullAssertion": "error",
        "noNonNullAssertedOptionalChain": "error",
        "noPrototypeBuiltins": "error",
        "noRedeclare": "error",
        "noSelfCompare": "error",
        "noShadowRestrictedNames": "error",
        "noUnsafeFinally": "error",
        "noUnsafeNegation": "error",
        "noUnsafeOptionalChainingOnConstant": "error",
        "noVar": "error",
        "useAwait": "error",
        "useValidTypeof": "error"
      },

      // STYLE - Expand significantly
      "style": {
        // Current rules
        "useConst": "error",
        "noInferrableTypes": "error",
        "useNodejsImportProtocol": "error",
        "noParameterAssign": "error",
        "useAsConstAssertion": "error",
        "useDefaultParameterLast": "error",
        "useEnumInitializers": "error",
        "useSelfClosingElements": "error",
        "useSingleVarDeclarator": "error",
        "noUnusedTemplateLiteral": "error",
        "useNumberNamespace": "error",
        "noUselessElse": "error",
        "useNamingConvention": { /* ... */ },
        "useFilenamingConvention": { /* ... */ },
        
        // Additional rules for ultrastrict
        "noCommaOperator": "error",
        "noDefaultExport": "warn", // Warn instead of error
        "noDuplicateImports": "error",
        "noEmptyBlockStatements": "error",
        "noNonNullAssertion": "error",
        "noUnnecessaryElse": "error",
        "noUnnecessaryFragments": "error",
        "useBlockStatements": "error",
        "useCollapsedElseIf": "error",
        "useConsistentNewlines": "error",
        "useDefaultSwitchClauseLast": "error",
        "useExponentiationOperator": "error",
        "useLogicalAssignment": "error",
        "useObjectShorthandProperties": "error",
        "usePlatformLog": "error",
        "useShorthandAssignments": "error",
        "useTemplate": "error",
        "useTrimStartEnd": "error",
        "useWhile": "error"
      },

      // COMPLEXITY - Keep and potentially expand
      "complexity": {
        "noExcessiveCognitiveComplexity": "error",
        "noUselessCatch": "error",
        "noUselessConstructor": "error",
        "useLiteralKeys": "off" // Keep as is
      },

      // PERFORMANCE - Expand
      "performance": {
        "noDelete": "error",
        "noAccumulatingSpread": "error",
        "noBarrelFile": "warn" // May be too restrictive
      },

      // SECURITY - Expand
      "security": {
        "noDangerouslySetInnerHtml": "error",
        "noGlobalEval": "error"
      },

      // NURSERY - Careful with unstable rules
      "nursery": {
        "noFloatingPromises": "error"
      }
    }
  },
  "formatter": {
    // Keep existing formatter settings
    "enabled": true,
    "formatWithErrors": false,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  // Keep overrides but may need refinement
  "overrides": [ /* ... */ ]
}
```

---

## Expected Impact

### Positive
- ✅ **Significantly stricter code quality** — Catches more potential bugs and style inconsistencies
- ✅ **Better accessibility** — 34 accessibility rules will improve WCAG compliance
- ✅ **Enhanced security** — Additional security checks prevent dangerous patterns
- ✅ **Improved maintainability** — More consistent code style across monorepo
- ✅ **Performance optimizations** — Rules to catch inefficient patterns

### Challenges
- ⚠️ **High initial violation count** — Expect 100-500+ errors across codebase
- ⚠️ **Breaking changes required** — Many existing files will need refactoring
- ⚠️ **Test/E2E file adjustments** — Many overrides may need reconfiguration
- ⚠️ **Build time** — More rules = slightly longer lint time (negligible)

### Estimated Violations by Category
Based on typical monorepo patterns:
- **Accessibility:** 50-100 violations (form labels, button types, ARIA attributes)
- **Correctness:** 20-50 violations (unused imports, implicit any)
- **Suspicious:** 30-80 violations (non-null assertions, dangerous patterns)
- **Style:** 100-300 violations (naming conventions, template usage, shorthand)
- **Performance:** 10-30 violations (spreading patterns, barrel files)
- **Security:** 5-20 violations (eval, innerHTML)

**Total Estimated:** 200-600+ violations to fix

---

## Version Compatibility Matrix

| Package              | Current | Latest | Compatible |
|----------------------|---------|--------|------------|
| @biomejs/biome       | 2.3.8   | 2.3.x  | ✅ Yes     |
| Node.js              | 22.x    | 22.x   | ✅ Yes     |
| TypeScript           | 5.9.3   | 5.9.3  | ✅ Yes     |
| Turborepo            | 2.6.1   | 2.6.1  | ✅ Yes     |
| pnpm                 | 10.17.0 | 10.17.0| ✅ Yes     |

**No dependency version changes required** for configuration-only changes.

---

## Implementation Checklist

- [ ] Create new `biome.json.ultrastrict` configuration file
- [ ] Document all rule additions in configuration
- [ ] Run `biome check .` to generate violation report
- [ ] Categorize violations by type and severity
- [ ] Create follow-up tickets for each violation category
- [ ] Update this document with actual violation counts
- [ ] Prepare migration guide for team
- [ ] Set up CI check for new stricter rules (can be warning initially)

---

## Resources & References

- **Official Biome Docs:** https://biomejs.dev
- **Biome 2.3 Rules:** https://biomejs.dev/linter/rules
- **Biome Configuration:** https://biomejs.dev/guides/configure-biome
- **Migration Guide:** https://biomejs.dev/blog/biome-v2-3/

---

## Next Steps

1. **Approval:** Review this analysis with team
2. **Create Jira Ticket:** "BST-XXX: Implement Biome 2.3 Ultrastrict Configuration"
3. **Implementation Phase:** Create configuration, run analysis, report findings
4. **Remediation Phase:** Fix violations in follow-up tickets
5. **Deployment:** Merge and activate for all CI/CD pipelines

---

**Analysis Completed:** 2025-11-30  
**Prepared By:** Claude Code Assistant  
**Status:** Ready for Implementation Planning
