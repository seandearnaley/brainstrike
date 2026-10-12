// BST-1964: upstream fix https://github.com/chromium/chromium/commit/909a0222ba0f48ace3fd3a011b379dcd998871bb
// Remove this executable override when bundled Chromium passes the same native
// cold-roundtrip and app persistence qualification gates.
export const WEB_CHROMIUM_VERSION = '154.0.8037.57';

/** @param {string} platform @param {string} arch
 * @returns {{ executable: string, platform: string, url: string }}
 */
export function getWebChromiumTarget(platform, arch) {
  /** @type {Readonly<Record<string, string>>} */
  const artifacts = {
    'darwin-arm64': 'mac-arm64',
    'darwin-x64': 'mac-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux64',
  };
  const artifact = artifacts[`${platform}-${arch}`];
  if (!artifact) {
    throw new Error(`Unsupported web Chromium host: ${platform}/${arch}`);
  }
  const executable =
    platform === 'darwin'
      ? `chrome-${artifact}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
      : `chrome-${artifact}/chrome`;
  return {
    executable,
    platform: artifact,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${WEB_CHROMIUM_VERSION}/${artifact}/chrome-${artifact}.zip`,
  };
}

/** @param {string | undefined} directory @param {string} platform @param {string} arch
 * @returns {string}
 */
export function getWebChromiumExecutablePath(directory, platform, arch) {
  if (!directory?.startsWith('/')) {
    throw new Error(
      'BRAINSTRIKE_WEB_CHROMIUM_DIR must name an explicit absolute provisioning directory'
    );
  }
  const target = getWebChromiumTarget(platform, arch);
  return `${directory}/${WEB_CHROMIUM_VERSION}/${target.platform}/${target.executable}`;
}
