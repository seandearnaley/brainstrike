import type { FileNodeType, IFileNode, SelectionState } from "@/lib/file/types";
import { vi } from "vitest";

interface BaseNodeOptions {
	name: string;
	path: string;
	depth?: number;
	selectionState?: SelectionState;
	rootFolderId?: string;
	isVisible?: boolean;
	children?: IFileNode[];
	handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
}

export function createFileNode({
	name = "test.txt",
	path = `/${name}`,
	depth = 0,
	selectionState = "unchecked",
	rootFolderId = "test-folder",
	isVisible = true,
	handle,
}: Partial<BaseNodeOptions> = {}): IFileNode {
	const mockHandle =
		handle ||
		({
			kind: "file" as const,
			name,
			getFile: vi.fn().mockResolvedValue(new File([], name)),
			createWritable: vi.fn(),
			isSameEntry: vi.fn(),
		} as unknown as FileSystemFileHandle);

	return {
		name,
		path,
		type: "file" as FileNodeType,
		handle: mockHandle,
		depth,
		selectionState,
		rootFolderId,
		isVisible,
	};
}

export function createDirectoryNode({
	name = "test-directory",
	path = `/${name}`,
	depth = 0,
	selectionState = "unchecked",
	rootFolderId = "test-folder",
	isVisible = true,
	children = [],
}: Partial<BaseNodeOptions> = {}): IFileNode {
	const mockHandle = {
		kind: "directory" as const,
		name,
		entries: vi.fn().mockResolvedValue([]),
		getDirectoryHandle: vi.fn(),
		getFileHandle: vi.fn(),
		removeEntry: vi.fn(),
		resolve: vi.fn(),
		isSameEntry: vi.fn(),
	} as unknown as FileSystemDirectoryHandle;

	return {
		name,
		path,
		type: "directory" as FileNodeType,
		handle: mockHandle,
		depth,
		selectionState,
		children,
		rootFolderId,
		isVisible,
	};
}

/**
 * Creates a nested directory structure for testing
 */
export function createNestedDirectoryStructure(
	basePath = "/",
	depth = 3,
	filesPerLevel = 2,
): IFileNode {
	const createLevel = (
		currentPath: string,
		currentDepth: number,
	): IFileNode => {
		if (currentDepth === 0) {
			return createDirectoryNode({
				name: currentPath.split("/").pop() || "root",
				path: currentPath,
				children: Array.from({ length: filesPerLevel }, (_, i) =>
					createFileNode({
						name: `file${i}.txt`,
						path: `${currentPath}/file${i}.txt`,
						depth: depth - currentDepth,
					}),
				),
				depth: depth - currentDepth,
			});
		}

		const children: IFileNode[] = [
			// Add files at this level
			...Array.from({ length: filesPerLevel }, (_, i) =>
				createFileNode({
					name: `file${i}.txt`,
					path: `${currentPath}/file${i}.txt`,
					depth: depth - currentDepth,
				}),
			),
			// Add subdirectories
			createLevel(`${currentPath}/subdir${currentDepth}`, currentDepth - 1),
		];

		return createDirectoryNode({
			name: currentPath.split("/").pop() || "root",
			path: currentPath,
			children,
			depth: depth - currentDepth,
		});
	};

	return createLevel(basePath, depth);
}

/**
 * Creates a file tree structure from a simple object representation
 */
export function createFileTreeFromStructure(
	structure: Record<string, unknown>,
	parentPath = "",
	depth = 0,
): IFileNode[] {
	return Object.entries(structure).map(([name, value]) => {
		const path = parentPath ? `${parentPath}/${name}` : name;

		if (value === null) {
			return createFileNode({
				name,
				path,
				depth,
			});
		}

		return createDirectoryNode({
			name,
			path,
			depth,
			children: createFileTreeFromStructure(
				value as Record<string, unknown>,
				path,
				depth + 1,
			),
		});
	});
}
