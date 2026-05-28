const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 50;
const CHARS_PER_TOKEN = 4;

/**
 * Canonical chunker configuration for the schema manifest. Any change
 * here is a breaking change for vector compatibility across paired
 * devices, so bump `version` whenever size/overlap shift.
 */
export const CHUNKER_PROFILE = Object.freeze({
  version: 3,
  size: DEFAULT_MAX_TOKENS,
  overlap: DEFAULT_OVERLAP_TOKENS,
  contextualPrefix: true,
});

/**
 * Split text into chunks respecting sentence boundaries.
 *
 * Returns: [{ content, index }]
 */
function chunkText(text, { maxTokens = DEFAULT_MAX_TOKENS, overlapTokens = DEFAULT_OVERLAP_TOKENS } = {}) {
  if (!text?.trim()) return [];

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  // If text fits in one chunk, return as-is
  if (text.length <= maxChars) {
    return [{ content: text.trim(), index: 0 }];
  }

  const sentences = splitSentences(text);
  const chunks = [];
  let current = '';
  let overlapBuffer = '';

  for (const sentence of sentences) {
    // Single sentence exceeds max — force-split by character
    if (sentence.length > maxChars) {
      if (current.trim()) {
        chunks.push({ content: current.trim(), index: chunks.length });
        overlapBuffer = getOverlap(current, overlapChars);
        current = '';
      }
      const forceSplit = splitLong(sentence, maxChars, overlapChars);
      for (const part of forceSplit) {
        chunks.push({ content: part.trim(), index: chunks.length });
      }
      overlapBuffer = getOverlap(chunks[chunks.length - 1].content, overlapChars);
      continue;
    }

    if ((current + sentence).length > maxChars) {
      chunks.push({ content: current.trim(), index: chunks.length });
      overlapBuffer = getOverlap(current, overlapChars);
      current = overlapBuffer + sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) {
    chunks.push({ content: current.trim(), index: chunks.length });
  }

  return chunks;
}

/**
 * Create section-aware chunks from labeled sections.
 * Each section is chunked independently with its heading preserved.
 *
 * Input: [{ heading, text }]
 * Returns: [{ content, index, sectionHeading }]
 */
function chunkSections(sections, options = {}) {
  const allChunks = [];

  for (const { heading, text } of sections) {
    if (!text?.trim()) continue;

    const sectionChunks = chunkText(text, options);
    for (const chunk of sectionChunks) {
      allChunks.push({
        content: chunk.content,
        index: allChunks.length,
        sectionHeading: heading,
      });
    }
  }

  return allChunks;
}

function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space or newline
  // Keeps the delimiter attached to the sentence
  const parts = text.split(/(?<=[.!?])\s+|(?<=\n)\s*/);
  return parts.filter((p) => p.trim());
}

function splitLong(text, maxChars, overlapChars) {
  const parts = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    parts.push(text.slice(start, end));
    start = end - overlapChars;
    if (start >= text.length) break;
  }

  return parts;
}

function getOverlap(text, overlapChars) {
  if (text.length <= overlapChars) return text;
  // Try to start overlap at a sentence boundary
  const tail = text.slice(-overlapChars);
  const sentenceStart = tail.search(/[.!?]\s+/);
  if (sentenceStart !== -1) return tail.slice(sentenceStart + 1).trimStart();
  return tail;
}

export { chunkText, chunkSections };
