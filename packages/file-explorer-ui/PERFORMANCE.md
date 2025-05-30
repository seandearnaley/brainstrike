# File Explorer UI Performance Benchmarks

These benchmarks demonstrate the impact of list virtualization on large file trees.

## Setup

A synthetic tree with 10,000 files was rendered in a test environment using `happy-dom`.
Render times were measured with `performance.now()`.

## Results

| Version            | Render Time |
|--------------------|-------------|
| Pre-virtualization | ~1300ms     |
| With virtualization| ~150ms      |

Virtualization reduces the initial render time by roughly **8x** when dealing with very large file sets.
