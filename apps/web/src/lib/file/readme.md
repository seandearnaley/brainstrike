# File System Module Documentation

This directory contains the core file system functionality for the Brainstrike web application. The module is organized into several focused components to maintain separation of concerns and improve maintainability.

## Module Structure

### `content.ts`
Handles file content reading and validation:
- Binary vs. text file detection
- File size validation
- Content reading with error handling

### `explorer.ts`
Manages file tree exploration and manipulation:
- Directory tree traversal
- Path filtering and ignoring
- File tree text representation
- File path handling

### `system.ts`
Core file system operations:
- Unique folder ID generation
- Directory comparison
- File system handle management
- Error handling for file system operations

### `types.ts`
Shared TypeScript types and interfaces:
- File node types
- Tree operation results
- Loading and selection options

## Key Features

1. **File Content Handling**
   - Automatic binary file detection
   - Size limit enforcement
   - Streaming content reading for large files

2. **Directory Tree Management**
   - Recursive directory traversal
   - Path filtering with glob patterns
   - Directory state persistence
   - Partial tree loading support

3. **Error Handling**
   - Graceful handling of permission errors
   - Support for partial tree loading
   - Clear error messages for common issues

## Usage Examples

```typescript
// Reading a file tree
const fileTree = await fileExplorer.readFullFileTree(directoryHandle);

// Checking if a file should be ignored
const shouldIgnore = fileExplorer.shouldIgnorePath(path);

// Getting file content
const content = await fileContent.readFileContent(fileHandle);
```

## Migration Notes

This module replaces the previous file system utilities that were spread across multiple locations. Key changes include:

1. Consolidated all file system operations into focused modules
2. Improved error handling and type safety
3. Better support for partial tree loading
4. Unified approach to path filtering and directory traversal

## Best Practices

1. Always use the provided utilities instead of direct file system access
2. Handle errors appropriately using the provided error types
3. Consider performance implications when traversing large directory trees
4. Use the file content validation utilities to prevent loading inappropriate files
