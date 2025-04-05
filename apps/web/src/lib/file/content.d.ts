/**
 * Utilities for validating and checking file content types
 */
export declare const fileContent: {
    /**
     * Checks if the content appears to be text by examining the first 512 bytes
     * for null bytes or control characters
     */
    isTextContent(content: string): boolean;
    /**
     * Checks if a file extension is known to be binary
     */
    isBinaryExtension(extension: string): boolean;
    /**
     * Checks if a file extension is known to be text
     */
    isTextExtension(extension: string): boolean;
    /**
     * Checks if a file size exceeds our maximum size limit
     */
    isFileTooLarge(size: number): boolean;
};
//# sourceMappingURL=content.d.ts.map