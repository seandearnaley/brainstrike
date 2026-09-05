/**
 * Input schemas for the embedded-browser-pane agent tools (BST-1176 PR2).
 *
 * Read-only seeing set: navigate the pane, read the live page as an
 * accessibility tree ([ref=eN] handles for PR3's act-by-ref), or as plain
 * text. Desktop-only — the pane exists only where a `WebContentsView` host
 * runs. Flat strict objects: there is no action union here, so an unknown key
 * is a hallucinated parameter and fails with an actionable one-line error.
 */
import { z } from 'zod';

/**
 * Matches the UI URL bar: schemes are gated main-side by `isNavigableUrl`.
 * The bare-host/search normalization lives in the TOOL description — not
 * repeated here (provider serializes both; prompt tokens are budgeted).
 */
export const BrowserNavigateInputSchema = z.strictObject({
  url: z.string().min(1).max(4096).describe('URL to open'),
});

export type BrowserNavigateInput = z.infer<typeof BrowserNavigateInputSchema>;

export const BrowserReadPageInputSchema = z.strictObject({
  filter: z
    .enum(['interactive', 'all'])
    .default('interactive')
    .describe("'interactive' returns only actionable elements; 'all' the full tree"),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(30_000)
    .default(6000)
    .describe('Maximum characters of tree text to return'),
});

export type BrowserReadPageInput = z.infer<typeof BrowserReadPageInputSchema>;

export const BrowserGetPageTextInputSchema = z.strictObject({
  maxChars: z
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(6000)
    .describe('Maximum characters to return'),
});

export type BrowserGetPageTextInput = z.infer<typeof BrowserGetPageTextInputSchema>;
