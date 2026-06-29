/**
 * Parse source code files into sections.
 * Splits by top-level constructs (functions, classes, exports).
 */
function parseCode(content, { language } = {}) {
  const lang = language || detectLanguage(content);

  // Split into logical sections by detecting boundaries
  const sections = splitByBlocks(content, lang);

  return {
    text: content.trim(),
    sections,
    metadata: { language: lang },
  };
}

function splitByBlocks(content, lang) {
  // Match common block boundaries: function/class/export declarations,
  // or groups of related code separated by blank lines
  const lines = content.split('\n');
  const sections = [];
  let currentHeading = 'Header';
  let currentLines = [];
  let braceDepth = 0;

  for (const line of lines) {
    const blockStart = detectBlockStart(line, lang);

    if (blockStart && braceDepth === 0) {
      if (currentLines.length) {
        sections.push({
          heading: currentHeading,
          text: currentLines.join('\n').trim(),
        });
      }
      currentHeading = blockStart;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }

    // Track brace depth for block scoping
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  if (currentLines.length) {
    sections.push({
      heading: currentHeading,
      text: currentLines.join('\n').trim(),
    });
  }

  // If we only got one section, fall back to paragraph-style splitting
  if (sections.length <= 1) {
    return splitByBlankLines(content);
  }

  return sections.filter((s) => s.text);
}

function detectBlockStart(line, _lang) {
  const trimmed = line.trim();

  // JavaScript/TypeScript
  const jsPatterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\{/,
    /^(?:export\s+default\s+)/,
  ];

  // Python
  const pyPatterns = [
    /^(?:async\s+)?def\s+(\w+)/,
    /^class\s+(\w+)/,
  ];

  // Go
  const goPatterns = [
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
    /^type\s+(\w+)/,
  ];

  const patterns = [...jsPatterns, ...pyPatterns, ...goPatterns];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1] || match[0].slice(0, 40);
  }

  return null;
}

function splitByBlankLines(content) {
  const blocks = content.split(/\n{2,}/);
  return blocks
    .map((block, i) => ({
      heading: `Block ${i + 1}`,
      text: block.trim(),
    }))
    .filter((s) => s.text);
}

function detectLanguage(content) {
  if (content.includes('import ') && (content.includes('from ') || content.includes('require('))) return 'javascript';
  if (content.match(/^def\s/m) || content.match(/^class\s.*:/m)) return 'python';
  if (content.match(/^func\s/m) || content.includes('package ')) return 'go';
  if (content.match(/^fn\s/m) || content.includes('use ')) return 'rust';
  return 'unknown';
}

export { parseCode };
