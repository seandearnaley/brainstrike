export class PartialRefreshError extends Error {
	constructor(
		message: string,
		public successCount: number,
		public failCount: number,
	) {
		super(message);
		this.name = "PartialRefreshError";
	}
}

export class FSInitializationError extends Error {
	constructor(
		message: string,
		public code?: string,
	) {
		super(message);
		this.name = "FSInitializationError";
	}
}

export class GitOperationError extends Error {
	constructor(
		message: string,
		public operation: string,
		public code?: string,
	) {
		super(message);
		this.name = "GitOperationError";
	}
}

export class FileContentError extends Error {
	constructor(
		message: string,
		public path: string,
		public code: "TOO_LARGE" | "BINARY" | "LOADING_ERROR" | "INVALID_FILE",
	) {
		super(message);
		this.name = "FileContentError";
	}
}

export class ConcurrentLoadingError extends Error {
	constructor(
		message: string,
		public failedPaths: string[],
	) {
		super(message);
		this.name = "ConcurrentLoadingError";
	}
}
