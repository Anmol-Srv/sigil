// Search returns POINTERS to documents, not document text — that split is what
// keeps recall cheap while whole documents stay available on demand. A fact
// carrying a bare `sourceDocumentIds: [7]` told an agent nothing; it needs a
// title and a uid to know a document exists and how to fetch it.

import { describe, it, expect } from 'vitest';

import { mapSourceDocuments } from './search.js';

const ROWS = [
  { id: 7, uid: 'doc-aaa', title: 'Design Notes', sourceType: 'file' },
  { id: 9, uid: 'doc-bbb', title: 'Retro', sourceType: 'raw' },
];

describe('mapSourceDocuments', () => {
  it('turns ids into fetchable {uid, title, sourceType}', () => {
    const [fact] = mapSourceDocuments([{ sourceDocumentIds: [7] }], ROWS);
    expect(fact.sourceDocuments).toEqual([{ uid: 'doc-aaa', title: 'Design Notes', sourceType: 'file' }]);
  });

  it('matches across number/string id types', () => {
    // The exact mismatch this guards: int[] from the fact row vs a string id
    // from the driver. A `===` compare would drop the pointer silently.
    const [fact] = mapSourceDocuments([{ sourceDocumentIds: ['7'] }], ROWS);
    expect(fact.sourceDocuments).toHaveLength(1);
    const [f2] = mapSourceDocuments([{ sourceDocumentIds: [7] }], [{ id: '7', uid: 'doc-aaa', title: 'D', sourceType: 'file' }]);
    expect(f2.sourceDocuments).toHaveLength(1);
  });

  it('handles a fact sourced from several documents', () => {
    const [fact] = mapSourceDocuments([{ sourceDocumentIds: [7, 9] }], ROWS);
    expect(fact.sourceDocuments.map((d) => d.uid)).toEqual(['doc-aaa', 'doc-bbb']);
  });

  it('drops ids with no surviving document instead of emitting holes', () => {
    const [fact] = mapSourceDocuments([{ sourceDocumentIds: [7, 404] }], ROWS);
    expect(fact.sourceDocuments).toEqual([{ uid: 'doc-aaa', title: 'Design Notes', sourceType: 'file' }]);
  });

  it('gives a fact with no source document an empty list, not undefined', () => {
    const [fact] = mapSourceDocuments([{}], ROWS);
    expect(fact.sourceDocuments).toEqual([]);
  });
});
