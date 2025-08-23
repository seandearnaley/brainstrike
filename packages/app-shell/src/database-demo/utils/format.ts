import { formatFileSize as formatFileSizeUtil } from '@brainstrike/utils';

export const formatFileSize = (bytes?: number): string => {
  if (bytes === undefined) return '';
  return formatFileSizeUtil(bytes);
};

export const formatDate = (isoString: string): string => {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
};
