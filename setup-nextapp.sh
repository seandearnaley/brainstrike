#!/bin/bash

# Define source and destination directories
SRC_DIR="/Users/seandearnaley/Documents/GitHub/brainstrike-web"
DEST_DIR="/Users/seandearnaley/Documents/GitHub/brainstrike/next-app"

# Create necessary directories
mkdir -p "$DEST_DIR"

# Copy source files
cp -r "$SRC_DIR/src" "$DEST_DIR/"
cp -r "$SRC_DIR/public" "$DEST_DIR/"

# Copy configuration files
cp "$SRC_DIR/package.json" "$DEST_DIR/"
cp "$SRC_DIR/package-lock.json" "$DEST_DIR/" 2>/dev/null || cp "$SRC_DIR/pnpm-lock.yaml" "$DEST_DIR/" 2>/dev/null
cp "$SRC_DIR/next.config.mjs" "$DEST_DIR/"
cp "$SRC_DIR/postcss.config.js" "$DEST_DIR/" 2>/dev/null
cp "$SRC_DIR/postcss.config.mjs" "$DEST_DIR/" 2>/dev/null
cp "$SRC_DIR/tailwind.config.js" "$DEST_DIR/" 2>/dev/null
cp "$SRC_DIR/tailwind.config.ts" "$DEST_DIR/" 2>/dev/null
cp "$SRC_DIR/tsconfig.json" "$DEST_DIR/"
cp "$SRC_DIR/biome.json" "$DEST_DIR/" 2>/dev/null
cp "$SRC_DIR/components.json" "$DEST_DIR/" 2>/dev/null

# Copy the out directory if it exists (static export)
if [ -d "$SRC_DIR/out" ]; then
  cp -r "$SRC_DIR/out" "$DEST_DIR/"
fi

# Create a .gitignore file to avoid committing node_modules and build artifacts
cat > "$DEST_DIR/.gitignore" << EOF
node_modules
.next
.turbo
.vercel
.env
.env.local
EOF

echo "Next.js app successfully copied to $DEST_DIR"