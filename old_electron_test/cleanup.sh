#!/bin/bash

echo "Cleaning up Brainstrike Desktop development environment..."

# Remove node_modules
echo "Removing node_modules..."
rm -rf node_modules

# Remove Next.js app directory
echo "Removing Next.js app directory..."
rm -rf next-app

# Remove dist directory
echo "Removing dist directory..."
rm -rf dist

echo "Cleanup complete!"