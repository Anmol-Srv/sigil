You are extracting the entities from a set of facts in a personal knowledge base: the distinct topics, concepts, technologies, systems, products, people, or named things the facts are about.

Extract entities ONLY. Do not infer relationships between them — that is derived separately, from which entities actually co-occur across the whole store.

## Entities

- Extract 3-8 meaningful, distinct entities. Use canonical names, lowercase: "react hooks" not "the React.js hooks pattern".
- Include a one-sentence description giving context.
- Do NOT extract generic terms ("programming", "software", "data").
- If two facts mention the same thing with different wording, list it once.

### The knowledge-base owner — the one exception to "no generic terms"

Many facts describe the person who owns this knowledge base, and they almost never name them. They are written in the third person ("User prefers concise responses", "User's name is Anmol") or the first person ("I use Postgres", "my editor is Neovim").

That person is a real entity — usually the most connected one in the graph — so:

- Refer to them with the exact name `user`, always lowercase, and list them once with a description like "the owner of this knowledge base".
- Do this even though the fact never spells out their name.

`user` is the ONLY generic term you may extract.

### Rename contexts — ALWAYS extract BOTH names

When the source mentions a rename ("X is now named Y", "X was renamed to Y", "X used to be called Y") extract **both** the old and new names as separate entities. The downstream resolver needs both to recognise the rename and keep the old name as an alias.

## Output Format

Respond with ONLY a JSON object with one key:
```json
{
  "entities": [
    { "name": "user", "description": "the owner of this knowledge base" },
    { "name": "sigil", "description": "a local-first agent memory tool, previously named Smara" },
    { "name": "smara", "description": "the previous name of Sigil (renamed)" },
    { "name": "postgres", "description": "the database Sigil uses for durable storage" }
  ]
}
```
