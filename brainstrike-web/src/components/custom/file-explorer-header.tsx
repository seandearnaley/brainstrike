import { FileExplorerStrings } from "./constants/file-explorer-constants";

export const FileExplorerHeader: React.FC = () => {
	return (
		<header className="p-4 border-b bg-gradient-to-b from-background/60 to-background">
			<h1 className="text-xl font-semibold tracking-tight">
				{FileExplorerStrings.TITLE}
			</h1>
			<p className="text-sm text-muted-foreground mt-1">
				Navigate and select files to include in your project
			</p>
		</header>
	);
};
