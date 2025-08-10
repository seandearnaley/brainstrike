#!/bin/bash

# Performance Testing Script for BrainStrike
# This script runs performance tests and establishes baselines

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
WEB_DIR="apps/web"
METRICS_DIR="$WEB_DIR/performance-metrics"
BASELINE_FILE="$METRICS_DIR/baseline.json"

# Function to print colored output
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

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to setup environment
setup_environment() {
    print_step "Setting up performance testing environment..."
    
    # Check required commands
    if ! command_exists pnpm; then
        print_error "pnpm is not installed. Please install pnpm first."
        exit 1
    fi
    
    if ! command_exists node; then
        print_error "Node.js is not installed. Please install Node.js first."
        exit 1
    fi
    
    # Create metrics directory
    mkdir -p "$METRICS_DIR"
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        print_step "Installing dependencies..."
        pnpm install
    fi
    
    # Build if needed
    if [ ! -d "apps/web/dist" ]; then
        print_step "Building applications..."
        pnpm build
    fi
    
    # Install Playwright if needed
    if [ ! -d "$WEB_DIR/node_modules/@playwright" ]; then
        print_step "Installing Playwright..."
        cd "$WEB_DIR"
        pnpm exec playwright install chromium
        cd - > /dev/null
    fi
    
    print_success "Environment setup complete"
}

# Function to run performance tests
run_performance_tests() {
    local test_type="$1"
    local mode="$2"
    
    print_step "Running $test_type performance tests..."
    
    cd "$WEB_DIR"
    
    case $test_type in
        "baseline"|"all")
            print_step "Running baseline benchmark tests..."
            pnpm exec playwright test performance-benchmarks.spec.ts --reporter=list
            ;;
        "memory")
            print_step "Running memory usage tests..."
            pnpm exec playwright test performance-memory-usage.spec.ts --reporter=list
            ;;
        "tree")
            print_step "Running tree rendering tests..."
            pnpm exec playwright test performance-tree-rendering.spec.ts --reporter=list
            ;;
        *)
            print_step "Running all performance tests..."
            pnpm exec playwright test performance-benchmarks.spec.ts performance-memory-usage.spec.ts performance-tree-rendering.spec.ts --reporter=list
            ;;
    esac
    
    cd - > /dev/null
}

# Function to consolidate metrics
consolidate_metrics() {
    print_step "Consolidating performance metrics..."
    
    cd "$WEB_DIR"
    
    node -e "
    const fs = require('fs');
    const path = require('path');
    
    const metricsDir = 'performance-metrics';
    if (!fs.existsSync(metricsDir)) {
        console.log('No metrics directory found');
        process.exit(0);
    }
    
    const files = fs.readdirSync(metricsDir).filter(f => f.endsWith('.json') && f.startsWith('metrics-'));
    
    if (files.length === 0) {
        console.log('No performance metrics found');
        process.exit(0);
    }
    
    console.log(\`Found \${files.length} metric files\`);
    
    const allMetrics = [];
    files.forEach(file => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(metricsDir, file), 'utf8'));
            if (data.metrics) {
                allMetrics.push(...data.metrics);
            } else if (Array.isArray(data)) {
                allMetrics.push(...data);
            }
        } catch (error) {
            console.error(\`Error reading \${file}:\`, error.message);
        }
    });
    
    if (allMetrics.length === 0) {
        console.log('No metrics found in files');
        process.exit(0);
    }
    
    const summary = {
        timestamp: new Date().toISOString(),
        metrics: allMetrics,
        summary: {
            total: allMetrics.length,
            passed: allMetrics.filter(m => m.passed !== false).length,
            failed: allMetrics.filter(m => m.passed === false).length,
        }
    };
    
    fs.writeFileSync(path.join(metricsDir, 'consolidated-metrics.json'), JSON.stringify(summary, null, 2));
    
    console.log('Metrics consolidated successfully');
    console.log(\`Total: \${summary.summary.total}, Passed: \${summary.summary.passed}, Failed: \${summary.summary.failed}\`);
    "
    
    cd - > /dev/null
}

# Function to show results
show_results() {
    print_step "Performance Test Results"
    
    local consolidated_file="$METRICS_DIR/consolidated-metrics.json"
    
    if [ ! -f "$consolidated_file" ]; then
        print_warning "No consolidated metrics found"
        return
    fi
    
    cd "$WEB_DIR"
    
    node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('performance-metrics/consolidated-metrics.json', 'utf8'));
    
    console.log('\\n📊 Performance Test Summary:');
    console.log('================================');
    console.log(\`Total metrics: \${data.summary.total}\`);
    console.log(\`Passed: \${data.summary.passed}\`);
    console.log(\`Failed: \${data.summary.failed}\`);
    console.log('');
    
    if (data.summary.failed > 0) {
        console.log('❌ Failed Metrics:');
        data.metrics.filter(m => m.passed === false).forEach(metric => {
            console.log(\`  • \${metric.name}: \${metric.value.toFixed(2)}\${metric.unit} > \${metric.threshold}\${metric.unit}\`);
        });
        console.log('');
    }
    
    console.log('📈 All Metrics:');
    data.metrics.forEach(metric => {
        const status = metric.passed !== false ? '✅' : '❌';
        console.log(\`  \${status} \${metric.name}: \${metric.value.toFixed(2)}\${metric.unit} (threshold: \${metric.threshold}\${metric.unit})\`);
    });
    "
    
    cd - > /dev/null
}

# Function to establish baseline
establish_baseline() {
    print_step "Establishing performance baseline..."
    
    local consolidated_file="$METRICS_DIR/consolidated-metrics.json"
    
    if [ ! -f "$consolidated_file" ]; then
        print_error "No consolidated metrics found. Run tests first."
        exit 1
    fi
    
    cp "$consolidated_file" "$BASELINE_FILE"
    print_success "Baseline established at $BASELINE_FILE"
}

# Function to compare with baseline
compare_with_baseline() {
    print_step "Comparing with baseline..."
    
    if [ ! -f "$BASELINE_FILE" ]; then
        print_warning "No baseline found. Establishing new baseline..."
        establish_baseline
        return
    fi
    
    local consolidated_file="$METRICS_DIR/consolidated-metrics.json"
    
    if [ ! -f "$consolidated_file" ]; then
        print_error "No current metrics found. Run tests first."
        exit 1
    fi
    
    cd "$WEB_DIR"
    
    node -e "
    const fs = require('fs');
    
    const currentData = JSON.parse(fs.readFileSync('performance-metrics/consolidated-metrics.json', 'utf8'));
    const baselineData = JSON.parse(fs.readFileSync('performance-metrics/baseline.json', 'utf8'));
    
    const currentMetrics = currentData.metrics;
    const baselineMetrics = baselineData.metrics || baselineData;
    
    console.log('\\n📊 Performance Comparison with Baseline:');
    console.log('==========================================');
    
    let improvements = 0;
    let regressions = 0;
    let stable = 0;
    
    currentMetrics.forEach(current => {
        const baseline = baselineMetrics.find(b => b.name === current.name);
        if (!baseline) {
            console.log(\`🆕 \${current.name}: \${current.value.toFixed(2)}\${current.unit} (new metric)\`);
            return;
        }
        
        const improvement = baseline.value === 0
          ? (current.value === 0 ? 0 : -Infinity)
          : ((baseline.value - current.value) / baseline.value) * 100;
        let status, arrow;
        
        if (improvement > 5) {
            status = 'IMPROVED';
            arrow = '⬇️';
            improvements++;
        } else if (improvement < -5) {
            status = 'REGRESSED';
            arrow = '⬆️';
            regressions++;
        } else {
            status = 'STABLE';
            arrow = '➡️';
            stable++;
        }
        
        console.log(\`\${arrow} \${current.name}: \${current.value.toFixed(2)}\${current.unit} vs \${baseline.value.toFixed(2)}\${current.unit} (\${improvement > 0 ? '+' : ''}\${improvement.toFixed(1)}%) - \${status}\`);
    });
    
    console.log('');
    console.log(\`Summary: \${improvements} improved, \${stable} stable, \${regressions} regressed\`);
    
    if (regressions > 0) {
        console.log('\\n⚠️  Performance regressions detected!');
        process.exit(1);
    }
    "
    
    cd - > /dev/null
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo "  run [TYPE]    Run performance tests (TYPE: all, baseline, memory, tree)"
    echo "  baseline      Establish new performance baseline"
    echo "  compare       Compare current results with baseline"
    echo "  results       Show latest test results"
    echo "  setup         Setup testing environment"
    echo ""
    echo "Examples:"
    echo "  $0 run all        # Run all performance tests"
    echo "  $0 run baseline   # Run only baseline tests"
    echo "  $0 baseline       # Establish baseline from latest results"
    echo "  $0 compare        # Compare with baseline"
}

# Main execution
main() {
    local command="${1:-run}"
    local test_type="${2:-all}"
    
    case $command in
        "setup")
            setup_environment
            ;;
        "run")
            setup_environment
            run_performance_tests "$test_type"
            consolidate_metrics
            show_results
            ;;
        "baseline")
            establish_baseline
            ;;
        "compare")
            compare_with_baseline
            ;;
        "results")
            show_results
            ;;
        "help"|"--help"|"-h")
            show_usage
            ;;
        *)
            print_error "Unknown command: $command"
            show_usage
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"
