import { createLogger } from '@brainstrike/utils/logger';

/**
 * Utility functions for URL handling and manipulation
 */

const logger = createLogger('UrlUtils');
/**
 * Removes trailing slashes from a URL or path
 * @param url The URL or path to normalize
 * @returns The URL without trailing slashes
 */
export function removeTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Adds a trailing slash to a URL or path if it doesn't already have one
 * @param url The URL or path to normalize
 * @returns The URL with a trailing slash
 */
export function addTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Joins URL parts together, handling slashes correctly
 * @param parts URL parts to join
 * @returns Joined URL
 */
export function joinUrlParts(...parts: string[]): string {
  const joined = parts
    .map((part, i) => {
      if (i === 0) {
        return part.replace(/\/+$/, '');
      }
      return part.replace(/^\/+|\/+$/g, '');
    })
    .filter(Boolean)
    .join('/');

  return joined.replace(/(?<!:)\/+/g, '/');
}

/**
 * Builds a URL with query parameters
 * @param baseUrl The base URL
 * @param params Object containing query parameters
 * @returns Full URL with query string
 */
export function buildUrl(
  baseUrl: string,
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const url = new URL(baseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      url.searchParams.append(key, String(value));
    }
  }

  return url.toString();
}

/**
 * Parses query parameters from a URL
 * @param url The URL to parse
 * @returns Object containing the query parameters
 */
export function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  try {
    const urlObj = new URL(url);
    for (const [key, value] of urlObj.searchParams.entries()) {
      params[key] = value;
    }
  } catch (error) {
    logger.debug('Failed to parse full URL, falling back to query string parsing', {
      error,
      url,
    });
    // If URL is invalid, try to parse just the query string
    const queryString = url.split('?')[1] || '';
    for (const param of queryString.split('&')) {
      const [key, value] = param.split('=');
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value || '');
      }
    }
  }

  return params;
}
