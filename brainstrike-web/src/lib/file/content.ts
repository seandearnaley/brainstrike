import {
	BINARY_FILE_EXTENSIONS,
	TEXT_FILE_EXTENSIONS,
} from "../../constants/file-explorer";

/**
 * Maximum file size in bytes that we'll attempt to load (1MB)
 */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

/**
 * Utilities for validating and checking file content types
 */
export const fileContent = {
	/**
	 * Checks if the content appears to be text by examining the first 512 bytes
	 * for null bytes or control characters
	 */
	isTextContent(content: string): boolean {
		const sampleSize = Math.min(512, content.length);
		for (let i = 0; i < sampleSize; i++) {
			const charCode = content.charCodeAt(i);
			// Check for null bytes or control characters (except tab, newline, carriage return)
			if (
				charCode === 0 || // null byte
				charCode < 0x09 || // control chars below tab
				(charCode > 0x0a && charCode < 0x0d) || // control chars between LF and CR
				(charCode > 0x0d && charCode < 0x20) || // control chars between CR and space
				charCode === 0x7f // DEL
			) {
				return false;
			}
		}
		return true;
	},

	/**
	 * Checks if a file extension is known to be binary
	 */
	isBinaryExtension(extension: string): boolean {
		const ext = extension.toLowerCase();
		return BINARY_FILE_EXTENSIONS.includes(
			ext.startsWith(".") ? ext : `.${ext}`,
		);
	},

	/**
	 * Checks if a file extension is known to be text
	 */
	isTextExtension(extension: string): boolean {
		const ext = extension.toLowerCase();
		return TEXT_FILE_EXTENSIONS.includes(ext.startsWith(".") ? ext : `.${ext}`);
	},

	/**
	 * Checks if a file size exceeds our maximum size limit
	 */
	isFileTooLarge(size: number): boolean {
		return size > MAX_FILE_SIZE_BYTES;
	},
};
