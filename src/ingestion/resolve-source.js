import { resolve } from 'node:path';

import { readSource } from './sources/file.js';
import { fetchSource } from './sources/url.js';

async function resolveSource({ content, url, filePath, title, sourceType, sourcePath, metadata }) {
  if (url) return fetchSource(url);

  if (filePath) {
    const resolved = resolve(filePath);
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd)) {
      throw new Error(`Path traversal denied: ${filePath} resolves outside working directory`);
    }
    return readSource(resolved);
  }

  if (content) {
    return {
      content,
      title: title || 'Untitled',
      sourcePath: sourcePath || `raw/${Date.now()}`,
      sourceType: sourceType || 'raw',
      contentType: 'text/plain',
      metadata: metadata || {},
    };
  }

  return null;
}

export { resolveSource };
