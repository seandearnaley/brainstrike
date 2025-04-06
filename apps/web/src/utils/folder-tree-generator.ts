import { minimatch } from "minimatch";
import type { IFileNode } from "@brainstrike/types";
import { processFilter } from "../utils/filter-utils";

export function generateProjectTreeText(
  fileTree: IFileNode[],
  includeFilters: string[] = [],
  excludeFilters: string[] = [],
  useRegex = false,
  folderSummaryThreshold = 5
): string {
  const lines: string[] = [];

  // Process filters only for glob patterns
  const processedIncludeFilters = useRegex
    ? includeFilters
    : includeFilters.map(processFilter);
  const processedExcludeFilters = useRegex
    ? excludeFilters
    : excludeFilters.map(processFilter);

  const matchesPattern = (
    path: string,
    patterns: string[],
    useRegex: boolean
  ): boolean => {
    if (patterns.length === 0) {
      return false;
    }

    for (const pattern of patterns) {
      try {
        if (useRegex) {
          // For regex mode, we use the pattern as is
          const regex = new RegExp(pattern);
          if (regex.test(path)) {
            return true;
          }
        } else {
          if (minimatch(path, pattern)) {
            return true;
          }
        }
      } catch (error) {
        console.error(`Invalid pattern: ${pattern}`, error);
      }
    }
    return false;
  };

  // Updated sorting function
  const sortFileNodes = (nodes: IFileNode[]): IFileNode[] => {
    return nodes.sort((a, b) => {
      // Directories first
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      // Both are same type, compare names without leading dots, case-insensitive
      const nameA = a.name.replace(/^\./, "").toLowerCase();
      const nameB = b.name.replace(/^\./, "").toLowerCase();
      return nameA.localeCompare(nameB, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
  };

  const traverse = (node: IFileNode) => {
    const path = node.path.startsWith("/") ? node.path.slice(1) : node.path;

    // Skip nodes that match the exclude filters
    if (matchesPattern(path, processedExcludeFilters, useRegex)) {
      return;
    }

    // Check if the node should be included
    let includeNode = false;

    if (node.type === "directory") {
      includeNode = true; // Always include directories (unless excluded)
    } else {
      // For files, check if they match the include filters
      if (processedIncludeFilters.length === 0) {
        includeNode = true;
      } else if (matchesPattern(path, processedIncludeFilters, useRegex)) {
        includeNode = true;
      }
    }

    // Determine indentation based on node depth
    const indentation = "  ".repeat(node.depth);

    // Add the node to the lines if it should be included
    if (includeNode) {
      lines.push(
        `${indentation}${node.name}${node.type === "directory" ? "/" : ""}`
      );
    }

    // Traverse and sort children if it's a directory
    if (node.type === "directory" && node.children) {
      // Filter and sort children
      const sortedChildren = sortFileNodes(node.children);
      const visibleChildren = sortedChildren.filter((child) => {
        const childPath = child.path.startsWith("/")
          ? child.path.slice(1)
          : child.path;
        return !matchesPattern(childPath, processedExcludeFilters, useRegex);
      });

      // If we have more children than the threshold, show summary
      if (
        folderSummaryThreshold > 0 &&
        visibleChildren.length > folderSummaryThreshold
      ) {
        // Show first N items
        for (const child of visibleChildren.slice(0, folderSummaryThreshold)) {
          traverse(child);
        }
        // Add summary line
        const remainingCount = visibleChildren.length - folderSummaryThreshold;
        const childIndentation = "  ".repeat(node.depth + 1);
        lines.push(
          `${childIndentation}... ${remainingCount} more ${
            remainingCount === 1 ? "item" : "items"
          }`
        );
      } else {
        // Show all children
        for (const child of visibleChildren) {
          traverse(child);
        }
      }
    }
  };

  // Sort root-level nodes before traversal
  const sortedRootNodes = sortFileNodes(fileTree);

  for (const rootNode of sortedRootNodes) {
    traverse(rootNode);
  }

  return lines.join("\n");
}
