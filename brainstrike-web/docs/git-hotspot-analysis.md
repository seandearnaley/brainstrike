# Git Hotspot Analysis Implementation Guide

## Overview
This document outlines the implementation of git hotspot analysis in our codebase. A "hotspot" is a file that requires frequent attention from developers, indicating it might be complex, unstable, or central to the codebase's functionality.

## Key Concepts

### What Makes a Good Hotspot Analysis?
A good hotspot analysis should:
1. Identify files that genuinely need attention
2. Not be skewed by non-meaningful changes (like formatting)
3. Weight recent changes more heavily than old ones
4. Handle files of different sizes fairly
5. Filter out noise from non-code files

## Implementation Details

### 1. File Filtering
```typescript
const shouldAnalyzeFile = (filepath: string): boolean => {
  if (IGNORED_FILES.some(ignored => filepath.endsWith(ignored))) {
    return false;
  }
  const ext = filepath.substring(filepath.lastIndexOf('.'));
  if (BINARY_FILE_EXTENSIONS.includes(ext)) {
    return false;
  }
  return TEXT_FILE_EXTENSIONS.includes(ext);
};
```

#### Rationale
- **Early Filtering**: Check file eligibility before content analysis to save processing time
- **Reuse Constants**: Use existing TEXT_FILE_EXTENSIONS and BINARY_FILE_EXTENSIONS from the codebase
- **Ignore Lists**: Skip files like package-lock.json that change frequently but aren't meaningful hotspots

### 2. Change Detection
```typescript
const linesA = contentAStr.split('\n');
const linesB = contentBStr.split('\n');

let differentLines = 0;
const maxLines = Math.max(linesA.length, linesB.length);
for (let i = 0; i < maxLines; i++) {
  if (linesA[i] !== linesB[i]) {
    differentLines++;
  }
}
```

#### Rationale
- **Line-by-Line Comparison**: Count actual different lines instead of just file size changes
- **TextDecoder**: Properly handle file encodings using TextDecoder for blob content
- **Maximum Lines**: Consider all lines when files have different lengths

### 3. Scoring System

#### Time Weight
```typescript
const timeDiff = now - commit.commit.author.timestamp;
const timeWeight = Math.max(0.1, 1 - (timeDiff / DAYS_30));
```

#### Rationale
- **Recent Changes Matter More**: Files changed recently get higher weights
- **30-Day Window**: Use a month as the primary time window
- **Minimum Weight**: Never completely discount old changes (0.1 minimum)

#### Change Weight
```typescript
const calculateChangeWeight = (differentLines: number): number => {
  const baseWeight = Math.log2(differentLines + 1);
  const MAX_WEIGHT = 10;
  return Math.min(baseWeight, MAX_WEIGHT);
};
```

#### Rationale
- **Logarithmic Scaling**: Use log2 to prevent large changes from dominating
- **Maximum Cap**: Limit the impact of extremely large changes
- **+1 Offset**: Handle cases with 0 lines changed

## Gotchas and Lessons Learned

### 1. Binary File Detection
- Initially missed binary files, leading to incorrect line counts
- Solution: Use existing file extension lists and proper text decoding

### 2. Large File Handling
- Package lock files dominated scores due to size
- Solution: 
  - Added to ignore list
  - Implemented maximum weight cap
  - Used logarithmic scaling

### 3. Merge Commits
- Initially included merge commits, skewing results
- Solution: Filter out commits with multiple parents

### 4. Score Calculation
- Early versions had all zero scores due to improper weight calculation
- Fixed by:
  - Ensuring proper time weight normalization
  - Adjusting logarithmic base and multipliers
  - Adding minimum weights

## Future Improvements

### 1. Enhanced Change Detection
- Consider implementing diff algorithms for more accurate change detection
- Track types of changes (additions vs modifications)
- Consider code complexity metrics

### 2. Configurable Weights
- Make time window configurable
- Allow adjustment of maximum weights
- Support custom file ignore patterns

### 3. Performance Optimization
- Cache blob content for frequently accessed commits
- Implement incremental analysis
- Parallelize file comparisons

## Best Practices

1. **Filter Early**: Check file eligibility before expensive operations
2. **Use Existing Code**: Leverage existing constants and utilities
3. **Handle Edge Cases**: Consider empty files, encoding issues, and large files
4. **Document Decisions**: Keep track of weight calculations and thresholds
5. **Test with Real Data**: Verify results against known hotspots in the codebase

## Conclusion
A good hotspot analysis requires careful balance between recency, change size, and file type considerations. The implementation should be both accurate and performant, while filtering out noise from non-meaningful changes.
