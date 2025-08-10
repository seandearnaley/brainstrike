#!/bin/bash

# Run performance tests multiple times for reliable data
set -e
shopt -s nullglob

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

WEB_DIR="apps/web"
RESULTS_DIR="$WEB_DIR/performance-benchmarks"
ITERATIONS=${1:-3}

mkdir -p "$RESULTS_DIR"

print_step "Running performance benchmarks with $ITERATIONS iterations"

# Function to run a specific test multiple times
run_test_iterations() {
    local test_name="$1"
    local test_grep="$2"
    local output_prefix="$3"
    
    print_step "Running $test_name ($ITERATIONS iterations)"
    
    declare -a memory_values=()
    declare -a interaction_values=()
    declare -a page_load_values=()
    
    for i in $(seq 1 $ITERATIONS); do
        echo "  Iteration $i/$ITERATIONS..."
        
        cd "$WEB_DIR"
        local output_file="$RESULTS_DIR/${output_prefix}_run_${i}.log"
        
        # Run test and capture output
        pnpm exec playwright test real-world-performance.spec.ts -g "$test_grep" --timeout=120000 > "$output_file" 2>&1 || true
        
        cd - > /dev/null
        
        # Extract metrics from output
        local memory=$(grep "Total memory increase:" "$output_file" | sed 's/.*: \([0-9]*\)MB/\1/' || echo "0")
        local interaction=$(grep "Average interaction time:" "$output_file" | sed 's/.*: \([0-9.]*\)ms/\1/' || echo "0")
        local page_load=$(grep "Page load time:" "$output_file" | sed 's/.*: \([0-9]*\)ms/\1/' || echo "0")
        
        if [[ "$memory" != "0" ]]; then
            memory_values+=($memory)
        fi
        
        if [[ "$interaction" != "0" ]]; then
            interaction_values+=($interaction)
        fi
        
        if [[ "$page_load" != "0" ]]; then
            page_load_values+=($page_load)
        fi
        
        echo "    Memory: ${memory}MB, Interaction: ${interaction}ms, Page Load: ${page_load}ms"
    done
    
    # Calculate averages
    local memory_avg=0
    local interaction_avg=0
    local page_load_avg=0
    
    if [[ ${#memory_values[@]} -gt 0 ]]; then
        memory_avg=$(echo "${memory_values[@]}" | tr ' ' '\n' | awk '{sum+=$1} END {print sum/NR}')
    fi
    
    if [[ ${#interaction_values[@]} -gt 0 ]]; then
        interaction_avg=$(echo "${interaction_values[@]}" | tr ' ' '\n' | awk '{sum+=$1} END {print sum/NR}')
    fi
    
    if [[ ${#page_load_values[@]} -gt 0 ]]; then
        page_load_avg=$(echo "${page_load_values[@]}" | tr ' ' '\n' | awk '{sum+=$1} END {print sum/NR}')
    fi
    
    # Save results
    cat > "$RESULTS_DIR/${output_prefix}_summary.json" << EOF
{
  "test_name": "$test_name",
  "iterations": $ITERATIONS,
  "memory": {
    "values": [$(IFS=,; echo "${memory_values[*]}")],
    "average": $memory_avg,
    "unit": "MB"
  },
  "interaction_time": {
    "values": [$(IFS=,; echo "${interaction_values[*]}")],
    "average": $interaction_avg,
    "unit": "ms"
  },
  "page_load_time": {
    "values": [$(IFS=,; echo "${page_load_values[*]}")],
    "average": $page_load_avg,
    "unit": "ms"
  }
}
EOF
    
    print_success "$test_name Results:"
    echo "  Memory Growth: ${memory_avg}MB (avg of ${#memory_values[@]} runs)"
    echo "  Interaction Time: ${interaction_avg}ms (avg of ${#interaction_values[@]} runs)"
    echo "  Page Load Time: ${page_load_avg}ms (avg of ${#page_load_values[@]} runs)"
    echo ""
}

# Run memory test
run_test_iterations "Memory Management" "validate memory management improvements" "memory"

# Run interaction test
run_test_iterations "Application Responsiveness" "validate overall application responsiveness" "responsiveness"

# Run render test
run_test_iterations "Render Performance" "validate shallow comparison fix prevents excessive re-renders" "renders"

# Create consolidated report
print_step "Creating consolidated performance report"

cat > "$RESULTS_DIR/consolidated_report.md" << 'EOF'
# Performance Benchmark Results

This report shows the results of multiple test iterations for reliable performance measurements.

## Test Configuration
EOF

echo "- Iterations per test: $ITERATIONS" >> "$RESULTS_DIR/consolidated_report.md"
echo "- Test date: $(date)" >> "$RESULTS_DIR/consolidated_report.md"
echo "" >> "$RESULTS_DIR/consolidated_report.md"

# Add results from each test
for test_file in "$RESULTS_DIR"/*_summary.json; do
    if [[ -f "$test_file" ]]; then
        test_name=$(grep '"test_name"' "$test_file" | cut -d'"' -f4)
        memory_avg=$(grep '"average":' "$test_file" | head -1 | cut -d':' -f2 | cut -d',' -f1 | tr -d ' ')
        interaction_avg=$(grep '"average":' "$test_file" | tail -2 | head -1 | cut -d':' -f2 | cut -d',' -f1 | tr -d ' ')
        page_load_avg=$(grep '"average":' "$test_file" | tail -1 | cut -d':' -f2 | cut -d',' -f1 | tr -d ' ')
        
        cat >> "$RESULTS_DIR/consolidated_report.md" << EOF

## $test_name
- **Memory Growth**: ${memory_avg}MB
- **Interaction Time**: ${interaction_avg}ms  
- **Page Load Time**: ${page_load_avg}ms

EOF
    fi
done

cat >> "$RESULTS_DIR/consolidated_report.md" << 'EOF'

## Performance Targets
- Memory Growth: Target <50MB
- Interaction Time: Target <500ms
- Page Load Time: Target <300ms

## Next Steps
Based on these reliable baseline measurements, focus optimization efforts on the metrics that are furthest from targets.
EOF

print_success "Performance benchmarking completed!"
echo "📁 Results saved in: $RESULTS_DIR/"
echo "📄 Consolidated report: $RESULTS_DIR/consolidated_report.md"

# Show quick summary
echo ""
echo "📊 QUICK SUMMARY (averaged across $ITERATIONS runs):"
for test_file in "$RESULTS_DIR"/*_summary.json; do
    if [[ -f "$test_file" ]]; then
        test_name=$(grep '"test_name"' "$test_file" | cut -d'"' -f4)
        memory_avg=$(grep '"average":' "$test_file" | head -1 | cut -d':' -f2 | cut -d',' -f1 | tr -d ' ')
        interaction_avg=$(grep '"average":' "$test_file" | tail -2 | head -1 | cut -d':' -f2 | cut -d',' -f1 | tr -d ' ')
        
        echo "  $test_name:"
        if [[ "$memory_avg" != "0" ]]; then
            echo "    Memory: ${memory_avg}MB"
        fi
        if [[ "$interaction_avg" != "0" ]]; then
            echo "    Interaction: ${interaction_avg}ms"
        fi
    fi
done
