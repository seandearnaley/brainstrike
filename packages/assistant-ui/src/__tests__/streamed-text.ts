import type { MatcherFunction } from '@testing-library/react';

/**
 * Matches the element that shows `text` while its reply is still streaming.
 * Streamdown's word reveal (`animated`) wraps each word of a running text part
 * in its own span until the part settles, so an exact string matcher finds no
 * single element. The match is the innermost element whose whole text content
 * is `text`.
 */
export function streamedText(text: string): MatcherFunction {
  return (_content, element) =>
    element !== null &&
    element.textContent === text &&
    Array.from(element.children).every((child) => child.textContent !== text);
}
