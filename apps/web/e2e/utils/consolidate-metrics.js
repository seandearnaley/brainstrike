#!/usr/bin/env node

/**
 * Consolidate performance metrics from multiple test runs
 * This script is used by GitHub Actions to merge performance metrics
 */

const fs = require('node:fs');
const path = require('node:path');

function consolidateMetrics() {
  try {
    const metricsDir = 'performance-metrics';

    // Check if metrics directory exists
    if (!fs.existsSync(metricsDir)) {
      console.log('No performance metrics directory found');
      process.exit(0);
    }

    // Get all JSON files that start with 'metrics-'
    const files = fs
      .readdirSync(metricsDir)
      .filter((f) => f.endsWith('.json') && f.startsWith('metrics-'));

    if (files.length === 0) {
      console.log('No performance metrics found');
      process.exit(0);
    }

    console.log(`Found ${files.length} metric files:`, files);

    // Merge all metrics
    const allMetrics = [];
    const errors = [];

    files.forEach((file) => {
      try {
        const filePath = path.join(metricsDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (data.metrics && Array.isArray(data.metrics)) {
          allMetrics.push(...data.metrics);
        } else if (Array.isArray(data)) {
          allMetrics.push(...data);
        } else {
          console.warn(`Skipping file ${file}: unexpected format`);
        }
      } catch (error) {
        console.error(`Error processing file ${file}:`, error.message);
        errors.push({ error: error.message, file });
      }
    });

    // Create summary
    const summary = {
      branch: process.env.GITHUB_REF_NAME || 'unknown',
      commit: process.env.GITHUB_SHA || 'unknown',
      environment: process.env.GITHUB_ACTIONS ? 'github-actions' : process.env.CI ? 'ci' : 'local',
      errors,
      metrics: allMetrics,
      summary: {
        failed: allMetrics.filter((m) => m.passed === false).length,
        passed: allMetrics.filter((m) => m.passed !== false).length,
        total: allMetrics.length,
      },
      timestamp: new Date().toISOString(),
    };

    // Save consolidated metrics
    const outputPath = path.join(metricsDir, 'consolidated-metrics.json');
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));

    // Output summary
    console.log('\n📊 Performance Summary:');
    console.log(`Total metrics: ${summary.summary.total}`);
    console.log(`Passed: ${summary.summary.passed}`);
    console.log(`Failed: ${summary.summary.failed}`);
    console.log(`Environment: ${summary.environment}`);

    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
    }

    console.log(`\nConsolidated metrics saved to: ${outputPath}`);

    // Set GitHub Actions output
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::set-output name=total::${summary.summary.total}`);
      console.log(`::set-output name=passed::${summary.summary.passed}`);
      console.log(`::set-output name=failed::${summary.summary.failed}`);
    }

    // Exit with error code if there were failed metrics
    if (summary.summary.failed > 0) {
      console.error(`\n❌ ${summary.summary.failed} performance metrics failed!`);
      process.exit(1);
    }

    console.log('\n✅ All performance metrics passed!');
  } catch (error) {
    console.error('❌ Error consolidating metrics:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  consolidateMetrics();
}

module.exports = { consolidateMetrics };
