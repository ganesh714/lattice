import { SupportedLanguage, BoundaryPatterns } from "./LanguageDetector";

export interface FileChunk {
  chunkId: number;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Splits file content into logical chunks based on language boundaries.
 * Falls back to fixed-size chunks for unknown languages.
 */
export function chunkFile(
  content: string,
  language: SupportedLanguage,
  chunkSize = 300
): FileChunk[] {
  const lines = content.split("\n");

  const pattern = BoundaryPatterns[language];
  const chunks: FileChunk[] = [];

  if (!pattern) {
    // Fixed-size chunking for unknown languages
    for (let i = 0; i < lines.length; i += chunkSize) {
      const slice = lines.slice(i, i + chunkSize);
      chunks.push({
        chunkId: chunks.length,
        startLine: i + 1,
        endLine: Math.min(i + chunkSize, lines.length),
        content: slice.join("\n"),
      });
    }
    return chunks;
  }

  // Boundary-aware chunking
  let start = 0;
  const boundaries: number[] = [0];

  for (let i = 1; i < lines.length; i++) {
    if (pattern.test(lines[i]) && i - start >= 20) {
      boundaries.push(i);
      start = i;
    }
  }
  boundaries.push(lines.length);

  // Merge tiny chunks to avoid excessive API calls
  let i = 0;
  while (i < boundaries.length - 1) {
    let end = boundaries[i + 1];
    // Merge forward if the chunk is too small
    while (end - boundaries[i] < chunkSize / 2 && i + 2 < boundaries.length) {
      i++;
      end = boundaries[i + 1];
    }
    const slice = lines.slice(boundaries[i], end);
    chunks.push({
      chunkId: chunks.length,
      startLine: boundaries[i] + 1,
      endLine: end,
      content: slice.join("\n"),
    });
    i++;
  }

  return chunks;
}
