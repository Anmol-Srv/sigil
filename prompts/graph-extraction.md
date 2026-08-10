You are building a knowledge graph from a set of facts in a personal knowledge base. In a SINGLE pass you extract two things together:

1. **Entities** — the distinct topics, concepts, technologies, systems, products, or named things the facts are about.
2. **Relationships** — the directed connections between those entities that the facts assert.

Extracting both together keeps them consistent: every relationship's endpoints should be entities you also list.

## Entities

- Extract 3-8 meaningful, distinct entities. Use canonical names, lowercase: "react hooks" not "the React.js hooks pattern".
- Include a one-sentence description giving context.
- Do NOT extract generic terms ("programming", "software", "data").
- If two facts mention the same thing with different wording, list it once.

### The knowledge-base owner — the one exception to "no generic terms"

Many facts describe the person who owns this knowledge base, and they almost never name them. They are written in the third person ("User prefers concise responses", "User's name is Anmol") or the first person ("I use Postgres", "my editor is Neovim").

That person is a real entity — usually the most connected one in the graph — so:

- Refer to them with the exact name `user`, always lowercase, and list them once in `entities` with a description like "the owner of this knowledge base".
- Emit the relationship the fact asserts about them, with `user` as the subject:
  `{"subject": "user", "relationship": "prefers", "object": "concise communication"}`.
- Use `prefers` / `dislikes` for opinions and taste, and ordinary verbs ("uses", "works on") for everything else.
- Do this even though the fact never spells out their name. Attaching the preference to `user` is the whole point — an object with no subject is an orphan.

`user` is the ONLY generic term you may extract. Every other rule below still applies to it.

### Rename contexts — ALWAYS extract BOTH names

When the source mentions a rename ("X is now named Y", "X was renamed to Y", "X used to be called Y") extract **both** the old and new names as separate entities, and also emit a "renamed from" relationship between them. The downstream resolver needs both names to recognise the rename and keep the old name as an alias.

## Relationships

- A relationship is `{subject, relationship, object}` — e.g. "sigil → uses → postgres".
- Use a **short, lowercase verb phrase** for the relationship: "uses", "depends on", "works on", "renamed from", "part of", "replaces", "integrates with", "created by", "located in". Do NOT invent codes like `USES`; write natural language. Normalization happens later.
- Subject and object must be two **different** entities, and both should appear in your entities list (or be concrete named things in the facts).
- Only assert relationships **explicitly stated or directly implied** by the facts. Never guess or add world knowledge.
- It is fine to return an empty relationships array if the facts assert no clear connections. Do not pad.

## Output Format

Respond with ONLY a JSON object with two keys:
```json
{
  "entities": [
    { "name": "user", "description": "the owner of this knowledge base" },
    { "name": "sigil", "description": "a local-first agent memory tool, previously named Smara" },
    { "name": "smara", "description": "the previous name of Sigil (renamed)" },
    { "name": "postgres", "description": "the database Sigil uses for durable storage" },
    { "name": "concise communication", "description": "short, direct replies without preamble" }
  ],
  "relationships": [
    { "subject": "sigil", "relationship": "renamed from", "object": "smara" },
    { "subject": "sigil", "relationship": "uses", "object": "postgres" },
    { "subject": "user", "relationship": "works on", "object": "sigil" },
    { "subject": "user", "relationship": "prefers", "object": "concise communication" }
  ]
}
```
