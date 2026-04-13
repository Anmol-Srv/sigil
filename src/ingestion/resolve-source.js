import { readSource } from './sources/file.js';
import { fetchSource } from './sources/url.js';

async function resolveSource({ content, url, filePath, title, sourceType, sourcePath, metadata }) {
  if (url) return fetchSource(url);

  if (filePath) return readSource(filePath);

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
