const REPETITIVE_CONTENT_LINE_THRESHOLD = 1000;
const REPETITIVE_CONTENT_UNIQUE_RATIO = 0.1;

export interface ContentRepetitionAnalysis {
  inspectedLines: number;
  isHighlyRepetitive: boolean;
  totalLines: number;
  uniqueLines: number;
}

export function analyzeContentRepetition(content: string): ContentRepetitionAnalysis {
  let totalLines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      totalLines += 1;
    }
  }

  if (totalLines <= REPETITIVE_CONTENT_LINE_THRESHOLD) {
    return {
      inspectedLines: 0,
      isHighlyRepetitive: false,
      totalLines,
      uniqueLines: 0,
    };
  }

  // The old split("\n") + Set construction retained every line substring and
  // an array with totalLines entries. Reaching this many distinct lines proves
  // the strict unique/total ratio cannot classify the content as repetitive,
  // so stop allocating line substrings as soon as that answer is known.
  const distinctLineLimit = Math.ceil(totalLines * REPETITIVE_CONTENT_UNIQUE_RATIO);
  const uniqueLines = new Set<string>();
  let inspectedLines = 0;
  let lineStart = 0;

  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
    uniqueLines.add(content.slice(lineStart, lineEnd));
    inspectedLines += 1;

    if (uniqueLines.size >= distinctLineLimit) {
      return {
        inspectedLines,
        isHighlyRepetitive: false,
        totalLines,
        uniqueLines: uniqueLines.size,
      };
    }
    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }

  return {
    inspectedLines,
    isHighlyRepetitive: true,
    totalLines,
    uniqueLines: uniqueLines.size,
  };
}
