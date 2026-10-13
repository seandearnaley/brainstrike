/** The existing conversation search singleton, independent of file-collection settings. */
export async function readDesktopThreadSearchProfile(): Promise<{
  modelKey: string;
  dimensions: number;
}> {
  return { dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' };
}
