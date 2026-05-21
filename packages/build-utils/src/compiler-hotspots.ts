/**
 * Determine if a file path corresponds to a React Compiler/HMR hotspot.
 * Cross-platform: supports Unix and Windows separators.
 */

const hotspotPatterns = [
  /packages[\\/](file-explorer-ui|file-explorer-hooks|hooks)[\\/]src[\\/].*\.(ts|tsx)$/,
  /packages[\\/]file-explorer-ui[\\/]src[\\/]workspace-settings\.tsx$/,
];

export function isCompilerHotspot(filePath: string): boolean {
  return hotspotPatterns.some((pattern) => pattern.test(filePath));
}
