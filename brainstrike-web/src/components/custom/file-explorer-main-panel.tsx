import { Folder } from "lucide-react";
import type React from "react";
import { Suspense, lazy } from "react";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../../components/ui/tabs";

const LoadingPanel = () => (
	<div className="flex items-center justify-center h-full">
		<div className="animate-pulse text-muted-foreground">Loading...</div>
	</div>
);

// Lazy load heavy components
const OramaSearchPanel = lazy(() =>
	import("./orama-search-panel").then((module) => ({
		default: module.OramaSearchPanel,
	})),
);
const PreviewPanel = lazy(() =>
	import("./preview-panel").then((module) => ({
		default: module.PreviewPanel,
	})),
);

interface FileExplorerMainPanelProps {
	rootDirectoryHandle: FileSystemDirectoryHandle | null;
	selectedFiles: Set<string>;
	fileContents: Record<string, string>;
	loadingFiles: Set<string>;
	onSelectionChange: (selectedFiles: Set<string>) => void;
}

const FileExplorerMainPanel: React.FC<FileExplorerMainPanelProps> = ({
	rootDirectoryHandle,
	selectedFiles,
	fileContents,
	loadingFiles,
	onSelectionChange,
}) => {
	if (!rootDirectoryHandle) {
		return (
			<div className="h-full flex items-center justify-center border-2 border-dashed rounded-lg p-6 bg-gradient-to-b from-card to-background/50">
				<div className="text-center text-muted-foreground max-w-sm">
					<Folder className="size-14 mx-auto mb-4 opacity-50" />
					<p className="text-sm @md/content:text-base">
						Select a root directory to view file details and Git information
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="@container/panel flex flex-col h-full overflow-hidden p-2">
			<Tabs defaultValue="preview" className="h-full flex flex-col">
				<TabsList className="flex shrink-0 w-full @xl/panel:w-auto mb-2">
					<TabsTrigger
						value="preview"
						className="flex-1 @xl/panel:flex-initial"
					>
						Preview
					</TabsTrigger>
					<TabsTrigger value="search" className="flex-1 @xl/panel:flex-initial">
						Search
					</TabsTrigger>
				</TabsList>
				<TabsContent
					value="preview"
					className="flex-1 overflow-hidden rounded-md bg-card/50 border"
					style={{ height: "calc(100% - 40px)" }}
				>
					<ScrollArea className="h-full w-full">
						<Suspense fallback={<LoadingPanel />}>
							<PreviewPanel
								selectedFiles={selectedFiles}
								fileContents={fileContents}
								loadingFiles={loadingFiles}
								onSelectionChange={onSelectionChange}
							/>
						</Suspense>
					</ScrollArea>
				</TabsContent>
				<TabsContent
					value="search"
					className="flex-1 overflow-hidden rounded-md bg-card/50 border"
					style={{ height: "calc(100% - 40px)" }}
				>
					<ScrollArea className="h-full w-full">
						<Suspense fallback={<LoadingPanel />}>
							<OramaSearchPanel
								selectedFiles={selectedFiles}
								fileContents={fileContents}
							/>
						</Suspense>
					</ScrollArea>
				</TabsContent>
			</Tabs>
		</div>
	);
};

export default FileExplorerMainPanel;
