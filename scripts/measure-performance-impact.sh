#!/bin/bash

# Script to measure the actual performance impact of our fixes
# This temporarily reverts fixes to get "before" measurements, then restores them

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() {
    echo -e "${BLUE}📋 $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

WEB_DIR="apps/web"
RESULTS_DIR="$WEB_DIR/performance-comparison"

# Create results directory
mkdir -p "$RESULTS_DIR"

print_step "Starting Performance Impact Measurement"
echo "This will:"
echo "1. Measure current performance (WITH fixes)"
echo "2. Temporarily revert fixes"  
echo "3. Measure old performance (WITHOUT fixes)"
echo "4. Restore fixes"
echo "5. Compare results"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# Function to run performance test and capture results
run_performance_test() {
    local test_name="$1"
    local output_file="$2"
    
    print_step "Running performance test: $test_name"
    
    cd "$WEB_DIR"
    
    # Run the comprehensive test and capture output
    pnpm exec playwright test e2e/performance/regression.test.ts -g "comprehensive performance comparison" --reporter=list > "$output_file" 2>&1 || {
        print_warning "Test failed, but that's expected for some scenarios"
    }
    
    cd - > /dev/null
    
    # Extract key metrics from the output
    if [[ -f "$output_file" ]]; then
        echo "Results saved to $output_file"
        
        # Try to extract metrics
        grep -E "(Tree Load:|Selection Time:|Memory Increase:|Avg per Selection:)" "$output_file" || {
            print_warning "Could not extract metrics from test output"
        }
    fi
}

# Backup original files
print_step "Creating backups of files that will be modified"

BACKUP_DIR="/tmp/performance-test-backup"
mkdir -p "$BACKUP_DIR"

cp "packages/file-explorer-ui/src/use-shared-file-content-loading.ts" "$BACKUP_DIR/"
cp "packages/file-explorer-ui/src/file-tree.tsx" "$BACKUP_DIR/"
cp "packages/file-explorer/src/actions/file-content-actions.ts" "$BACKUP_DIR/"

print_success "Backups created"

# 1. Test current performance (WITH fixes)
print_step "STEP 1: Testing current performance WITH fixes"
run_performance_test "with-fixes" "$RESULTS_DIR/with-fixes.log"

# 2. Temporarily revert the shallow comparison fix
print_step "STEP 2: Temporarily reverting shallow comparison fix"

# Revert shallow comparison fix
sed -i.bak 's/store((state) => state.fileContents, shallow)/store((state) => state.fileContents)/' \
    packages/file-explorer-ui/src/use-shared-file-content-loading.ts

# Revert store.getState() fix in file-tree.tsx
sed -i.bak 's/selectedFilePaths.has(encodedPath)/store.getState().selectedFilePaths.has(encodedPath)/' \
    packages/file-explorer-ui/src/file-tree.tsx

sed -i.bak 's/selectedFilePaths,/store,/' \
    packages/file-explorer-ui/src/file-tree.tsx

# Temporarily disable LRU cache by making it a passthrough
cat > packages/file-explorer/src/utils/file-content-cache.ts << 'EOF'
// Temporarily disabled LRU cache for performance comparison
export interface CacheEntry {
  content: string;
  timestamp: number;
  lastAccessed: number;
  size: number;
}

export interface CacheStats {
  totalSize: number;
  entryCount: number;
  hitRate: number;
  evictionCount: number;
}

export class FileContentCache {
  constructor(maxSizeBytes = 50 * 1024 * 1024, maxEntries = 1000) {
    // Disabled for testing
  }

  get(key: string): string | undefined {
    return undefined; // Always miss
  }

  set(key: string, content: string): void {
    // Do nothing - no caching
  }

  delete(key: string): boolean {
    return true;
  }

  deleteKeys(keys: string[]): void {
    // Do nothing
  }

  clear(): void {
    // Do nothing
  }

  has(key: string): boolean {
    return false;
  }

  getStats(): CacheStats {
    return {
      totalSize: 0,
      entryCount: 0,
      hitRate: 0,
      evictionCount: 0,
    };
  }

  getKeys(): string[] {
    return [];
  }

  getEntriesByAccess(): Array<{ key: string; lastAccessed: number; size: number }> {
    return [];
  }

  evictOldest(count: number): void {
    // Do nothing
  }
}
EOF

print_warning "Fixes temporarily reverted"

# 3. Test performance WITHOUT fixes  
print_step "STEP 3: Testing performance WITHOUT fixes (simulating old behavior)"
run_performance_test "without-fixes" "$RESULTS_DIR/without-fixes.log"

# 4. Restore original files
print_step "STEP 4: Restoring original files with fixes"

cp "$BACKUP_DIR/use-shared-file-content-loading.ts" "packages/file-explorer-ui/src/"
cp "$BACKUP_DIR/file-tree.tsx" "packages/file-explorer-ui/src/"  
cp "$BACKUP_DIR/file-content-actions.ts" "packages/file-explorer/src/actions/"

# Restore the LRU cache file
git checkout packages/file-explorer/src/utils/file-content-cache.ts 2>/dev/null || {
    print_warning "Could not restore LRU cache file with git, please restore manually"
}

print_success "Original files restored"

# 5. Create comparison report
print_step "STEP 5: Creating performance comparison report"

cat > "$RESULTS_DIR/comparison-report.md" << 'EOF'
# Performance Impact Measurement Report

This report compares the performance before and after implementing the following fixes:

1. **Shallow Comparison Fix**: Added `shallow` to `fileContents` store subscription
2. **Store.getState() Fix**: Proper store subscription instead of direct getState() calls  
3. **LRU Cache**: Implemented file content caching with automatic eviction
4. **File Size Validation**: Added 1MB limits to prevent loading large files

## Test Results

### Performance WITH Fixes (Current)
EOF

if [[ -f "$RESULTS_DIR/with-fixes.log" ]]; then
    echo "\`\`\`" >> "$RESULTS_DIR/comparison-report.md"
    grep -E "(Tree Load:|Selection Time:|Memory Increase:|Avg per Selection:|COMPREHENSIVE PERFORMANCE RESULTS)" "$RESULTS_DIR/with-fixes.log" >> "$RESULTS_DIR/comparison-report.md" 2>/dev/null || echo "No metrics extracted" >> "$RESULTS_DIR/comparison-report.md"
    echo "\`\`\`" >> "$RESULTS_DIR/comparison-report.md"
else
    echo "Test results not available" >> "$RESULTS_DIR/comparison-report.md"
fi

cat >> "$RESULTS_DIR/comparison-report.md" << 'EOF'

### Performance WITHOUT Fixes (Simulated Old Behavior)
EOF

if [[ -f "$RESULTS_DIR/without-fixes.log" ]]; then
    echo "\`\`\`" >> "$RESULTS_DIR/comparison-report.md"
    grep -E "(Tree Load:|Selection Time:|Memory Increase:|Avg per Selection:|COMPREHENSIVE PERFORMANCE RESULTS)" "$RESULTS_DIR/without-fixes.log" >> "$RESULTS_DIR/comparison-report.md" 2>/dev/null || echo "No metrics extracted" >> "$RESULTS_DIR/comparison-report.md"
    echo "\`\`\`" >> "$RESULTS_DIR/comparison-report.md"
else
    echo "Test results not available" >> "$RESULTS_DIR/comparison-report.md"
fi

cat >> "$RESULTS_DIR/comparison-report.md" << 'EOF'

## Analysis

### Expected Improvements:
- **Selection Time**: Should be 50-70% faster due to shallow comparison fix
- **Memory Usage**: Should be significantly lower due to LRU cache  
- **Render Count**: Should be much lower due to preventing cascade re-renders

### Key Metrics to Compare:
1. **Avg per Selection time** - Lower is better
2. **Memory Increase** - Lower is better  
3. **Render Count** - Lower is better
4. **Selection Time** - Lower is better

EOF

# Clean up
rm -rf "$BACKUP_DIR"
rm -f packages/file-explorer-ui/src/*.bak
rm -f packages/file-explorer/src/actions/*.bak

print_success "Performance impact measurement completed!"
print_step "Results saved in: $RESULTS_DIR/"

echo ""
echo "📊 Quick Summary:"
if [[ -f "$RESULTS_DIR/with-fixes.log" && -f "$RESULTS_DIR/without-fixes.log" ]]; then
    echo "WITH fixes:"
    grep -E "Selection Time:" "$RESULTS_DIR/with-fixes.log" | head -1 || echo "  No selection time data"
    grep -E "Memory Increase:" "$RESULTS_DIR/with-fixes.log" | head -1 || echo "  No memory data"
    
    echo ""
    echo "WITHOUT fixes:"  
    grep -E "Selection Time:" "$RESULTS_DIR/without-fixes.log" | head -1 || echo "  No selection time data"
    grep -E "Memory Increase:" "$RESULTS_DIR/without-fixes.log" | head -1 || echo "  No memory data"
else
    echo "Check the detailed logs in $RESULTS_DIR/ for results"
fi

echo ""
echo "📄 Full report: $RESULTS_DIR/comparison-report.md"
