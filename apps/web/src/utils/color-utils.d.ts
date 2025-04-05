interface ColorScheme {
    bg: string;
    text: string;
}
interface FolderColors {
    light: ColorScheme;
    dark: ColorScheme;
}
/**
 * Gets a consistent, accessible color combination for a folder.
 * @param str Input string to generate color from
 * @returns Object with light and dark theme color combinations
 */
export declare function getFolderColor(str: string): FolderColors;
export {};
//# sourceMappingURL=color-utils.d.ts.map