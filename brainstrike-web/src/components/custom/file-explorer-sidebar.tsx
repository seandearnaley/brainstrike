import type { IFileNode } from "@/lib/file/types";
import type React from "react";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../../components/ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../../components/ui/tooltip";
import { FileExplorerStrings } from "./constants/file-explorer-constants";
import FileTree from "./file-tree";
import { FolderBadge } from "./folder-badge";
import { GitPanel } from "./git-panel";

const NoFilesSelected = () => (
	<div className="text-center text-muted-foreground p-8">
		<p>No directory selected</p>
		<p className="text-sm mt-2">Use the folder button to select a directory</p>
	</div>
);

interface FileExplorerSidebarProps {
	rootDirectoryHandle: FileSystemDirectoryHandle | null;
	treeError: Error | null;
	filterError: Error | null;
	includeFilters: string[];
	excludeFilters: string[];
	useRegex: boolean;
	quickFilter: string;
	quickFilteredTree: IFileNode[] | null;
	loadingFiles: Set<string>;
	isLoading: boolean;
	isInitialLoad: boolean;
	currentFolderId: string | null;
	onTreeRender?: () => void;
}

const DirectoryStatus: React.FC<{
	rootDirectoryHandle: FileSystemDirectoryHandle | null;
}> = ({ rootDirectoryHandle }) => {
	if (!rootDirectoryHandle) return null;
	return (
		<div className="flex items-center gap-2 text-sm text-muted-foreground p-2 border-b">
			<span>{FileExplorerStrings.STATUS.CURRENT_DIRECTORY}</span>
			<FolderBadge folderId={rootDirectoryHandle.name} />
		</div>
	);
};

const FilterBadge: React.FC<{
	label: string;
	value: string;
	variant?: "default" | "secondary" | "destructive" | "outline";
}> = ({ label, value, variant = "secondary" }) => (
	<Tooltip>
		<TooltipTrigger>
			<Badge variant={variant} className="cursor-help">
				{value}
			</Badge>
		</TooltipTrigger>
		<TooltipContent>
			<p>{`${label}: ${value}`}</p>
		</TooltipContent>
	</Tooltip>
);

const FilterStatus: React.FC<{
	includeFilters: string[];
	excludeFilters: string[];
	useRegex: boolean;
	quickFilter: string;
}> = ({ includeFilters, excludeFilters, useRegex, quickFilter }) => {
	const hasFilters =
		includeFilters.length > 0 || excludeFilters.length > 0 || quickFilter;

	if (!hasFilters) return null;

	return (
		<TooltipProvider>
			<div className="flex items-center gap-2 flex-wrap p-2 border-b">
				{includeFilters.map((filter) => (
					<FilterBadge
						key={`include-${filter}`}
						label={FileExplorerStrings.STATUS.INCLUDE_FILTERS}
						value={filter}
						variant="default"
					/>
				))}
				{excludeFilters.map((filter) => (
					<FilterBadge
						key={`exclude-${filter}`}
						label={FileExplorerStrings.STATUS.EXCLUDE_FILTERS}
						value={filter}
						variant="destructive"
					/>
				))}
				{quickFilter && (
					<FilterBadge
						label={FileExplorerStrings.STATUS.QUICK_FILTER}
						value={quickFilter}
						variant="outline"
					/>
				)}
				{useRegex && (
					<Tooltip>
						<TooltipTrigger>
							<Badge variant="secondary" className="cursor-help">
								regex
							</Badge>
						</TooltipTrigger>
						<TooltipContent>
							<p>{FileExplorerStrings.STATUS.REGEX_MODE}</p>
						</TooltipContent>
					</Tooltip>
				)}
			</div>
		</TooltipProvider>
	);
};

const FileExplorerSidebar: React.FC<FileExplorerSidebarProps> = ({
	rootDirectoryHandle,
	treeError,
	filterError,
	includeFilters,
	excludeFilters,
	useRegex,
	quickFilter,
	quickFilteredTree,
	loadingFiles,
	isLoading,
	isInitialLoad,
	currentFolderId,
	onTreeRender,
}) => {
	return (
		<div className="flex-1 flex flex-col min-h-0 relative overflow-hidden">
			{(treeError || filterError) && !isLoading && !isInitialLoad && (
				<div
					className="bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 p-3 rounded m-2 text-sm"
					role="alert"
				>
					<strong>Error: </strong>
					{treeError?.message}
					{filterError && ` ${filterError.message}`}
				</div>
			)}
			<DirectoryStatus rootDirectoryHandle={rootDirectoryHandle} />
			<FilterStatus
				includeFilters={includeFilters}
				excludeFilters={excludeFilters}
				useRegex={useRegex}
				quickFilter={quickFilter}
			/>

			{!rootDirectoryHandle ? (
				<NoFilesSelected />
			) : (
				<Tabs
					defaultValue="files"
					className="h-full flex flex-col overflow-hidden"
				>
					<TabsList className="w-full shrink-0">
						<TabsTrigger value="files">Files</TabsTrigger>
						<TabsTrigger value="git">Git</TabsTrigger>
					</TabsList>
					<TabsContent value="files" className="flex-1 overflow-hidden">
						<ScrollArea className="h-full">
							<div className="p-2">
								{quickFilteredTree && quickFilteredTree.length > 0 ? (
									<FileTree
										fileTree={quickFilteredTree}
										loadingFiles={loadingFiles}
										onRender={onTreeRender}
										folderId={currentFolderId || ""}
									/>
								) : (
									<div className="text-center text-muted-foreground py-8">
										No matching files found
									</div>
								)}
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="git" className="flex-1 overflow-hidden">
						<GitPanel rootDirectoryHandle={rootDirectoryHandle} />
					</TabsContent>
				</Tabs>
			)}
		</div>
	);
};

export default FileExplorerSidebar;
