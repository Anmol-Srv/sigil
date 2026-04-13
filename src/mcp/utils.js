function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + '...';
}

const FACT_TRUNCATE = 200;

export { textResponse, truncate, FACT_TRUNCATE };
