import FS from "@isomorphic-git/lightning-fs";
import type React from "react";
import {
	type ReactNode,
	createContext,
	useContext,
	useEffect,
	useState,
} from "react";

// Create a context for the file system
interface FSContextType {
	fs: FS | null;
	isInitialized: boolean;
	error: Error | null;
}

const FSContext = createContext<FSContextType>({
	fs: null,
	isInitialized: false,
	error: null,
});

export const useFS = () => useContext(FSContext);

interface FSProviderProps {
	children: ReactNode;
}

export const FSProvider: React.FC<FSProviderProps> = ({ children }) => {
	const [fs, setFS] = useState<FS | null>(null);
	const [isInitialized, setIsInitialized] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		const initializeFS = async () => {
			try {
				// Initialize the lightning-fs file system
				const lightningFS = new FS("brainstrike-fs");

				// Ensure the file system is ready
				await new Promise<void>((resolve) => {
					setTimeout(() => {
						setFS(lightningFS);
						setIsInitialized(true);
						resolve();
					}, 100); // Small delay to ensure initialization
				});

				console.log("File system initialized successfully");
			} catch (err) {
				console.error("Failed to initialize file system:", err);
				setError(
					err instanceof Error
						? err
						: new Error("Unknown error initializing file system"),
				);
			}
		};

		initializeFS();

		// Cleanup function
		return () => {
			// Any cleanup needed for the file system
		};
	}, []);

	return (
		<FSContext.Provider value={{ fs, isInitialized, error }}>
			{children}
		</FSContext.Provider>
	);
};
