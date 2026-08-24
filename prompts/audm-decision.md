You are comparing two facts from an organizational knowledge base. Decide if the NEW fact should be added as a separate entry or if it updates/replaces the EXISTING fact.

## Decisions

- **UPDATE** — The new fact covers the same topic/event/observation as the existing fact, even if worded differently. They describe the same underlying thing. Replace the existing fact with the new version. **Err on the side of UPDATE** — a knowledge base with fewer, better facts is more useful than one with many overlapping facts.
- **ADD** — The new fact describes a genuinely different piece of information. Different event, different metric, different insight. Not just a rephrase.
- **CONTRADICT** — The new fact directly contradicts the existing fact (e.g., different numbers for the same metric, opposite conclusions).

## Examples

EXISTING: "Database Design session covered normalization from 1NF through 3NF"
NEW: "Database Design Fundamentals covered database normalization (1NF through 3NF), live schema design, and denormalization"
→ **UPDATE** (same core topic, new version adds more detail)

EXISTING: "Rahul Sharma recommended starting with PostgreSQL"
NEW: "In Q&A, a student asked about Redis vs PostgreSQL. Rahul recommended starting with PostgreSQL, moving to Redis for server-side revocation."
→ **UPDATE** (same recommendation, new version adds the question context)

EXISTING: "Session had 78% attendance with 32 of 41 enrolled"
NEW: "Session had 8 attendees with an average rating of 4.4/5"
→ **ADD** (different metrics — one is attendance %, other is count + rating)

EXISTING: "Students said 3NF was covered too quickly"
NEW: "Students requested more practice exercises for 3NF"
→ **UPDATE** (same underlying feedback about 3NF pacing)

EXISTING: "Session started 2 minutes late"
NEW: "Session started on time"
→ **CONTRADICT**

### State changing over time (same subject + attribute, new value)

When both facts describe the **same subject's same attribute or property** but the
value has changed — a tool was swapped, a role changed, a price moved, a system was
migrated — the OLD fact is no longer true. Choose UPDATE (the new value replaces the
old) or CONTRADICT (the old assertion is now false). Do **not** choose ADD just because
the new fact is phrased as an event ("was migrated", "was promoted", "moved to"): a
migration/promotion still invalidates the prior state.

EXISTING: "The primary datastore is Redis"
NEW: "The application migrated from Redis to Postgres as the primary datastore"
→ **CONTRADICT** (same attribute — the primary datastore — old value Redis no longer holds)

EXISTING: "All session state is managed within Redis"
NEW: "Session state management was moved to Postgres LISTEN/NOTIFY"
→ **UPDATE** (same attribute — where session state lives — changed from Redis to Postgres)

EXISTING: "Priya works as a backend engineer on the payments team"
NEW: "Priya was promoted to engineering manager of the payments team"
→ **UPDATE** (same subject's role changed; she is no longer a backend engineer)

Respond with ONLY a JSON object, no prose and no markdown fences:
{"decisions":[{"input_index":<integer>,"candidate_key":"<string>","action":"ADD"|"UPDATE"|"CONTRADICT"}]}

Return exactly one entry per offered case, echoing that case's input_index and
candidate_key verbatim. Never omit a case, never merge cases, never add cases.
