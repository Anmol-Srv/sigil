/**
 * The editable configuration surface, described once.
 *
 * The Settings page used to hand-code a control per setting, so config.json
 * grew knobs the GUI never learned about — managed-session sizing, AUDM
 * thresholds, Hebbian decay, and (most recently) ingest.extractRelations, all
 * reachable only by editing JSON by hand. Describing the surface here and
 * having the GUI render whatever the daemon reports means a new setting shows
 * up in the UI the moment it is added to this list, and can never drift from
 * what the daemon actually honours.
 *
 * Deliberately NOT here:
 *   - secrets (apiKey, database.password, S3 keys). They go through the
 *     provider flow, which live-tests them before saving; a generic text box
 *     that writes an unverified key is worse than no box.
 *   - identity the user cannot meaningfully choose (device.id, schemaVersion,
 *     setup.steps) and provider identity, which the switcher owns.
 *
 * `restart: true` means the value is read once at daemon boot. Everything else
 * is read through config's live getters and takes effect on the next call.
 */

export const SETTINGS_SECTIONS = [
  {
    id: 'identity',
    title: 'Identity',
    help: 'Who this knowledge base belongs to. The owner is a real entity in the graph — facts written as "User prefers…" attach to this name.',
    settings: [
      { path: 'identity.name', label: 'Your name', type: 'text', placeholder: 'Anmol',
        help: 'Used to resolve the knowledge-base owner. Changing it re-points new owner facts; existing ones keep their entity.' },
      { path: 'defaults.namespace', label: 'Default namespace', type: 'text', placeholder: 'default',
        help: 'Namespace used when a caller does not name one.' },
    ],
  },
  {
    id: 'ingest',
    title: 'Ingestion',
    help: 'What happens when a fact or document is written.',
    settings: [
      { path: 'ingest.eagerExtract', label: 'Extract facts on write', type: 'boolean',
        help: 'Off defers extraction, so writes return sooner but nothing is searchable until it runs.' },
      { path: 'ingest.extractRelations', label: 'Extract relations during ingest', type: 'boolean',
        help: 'Off makes ingest markedly faster (measured 39.3s → 13.8s) by asking the model for entities only. Only turn it off if you run `sigil maintain --derive-relations`, or the graph stops gaining edges.' },
      { path: 'ingest.graphGleanRounds', label: 'Gleaning rounds', type: 'number', min: 0, max: 3, step: 1,
        help: 'Extra passes asking the model what it missed. Costs one call per round, on fact-dense documents only.' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory & deduplication',
    help: 'AUDM decides whether an incoming fact is new, an update, or a duplicate. These are cosine-similarity cutoffs between 0 and 1.',
    settings: [
      { path: 'memory.skipThreshold', label: 'Skip as duplicate above', type: 'number', min: 0, max: 1, step: 0.01,
        help: 'At or above this similarity a new fact is treated as a near-duplicate and dropped without asking the model.' },
      { path: 'memory.ambiguousThreshold', label: 'Ask the model above', type: 'number', min: 0, max: 1, step: 0.01,
        help: 'Between this and the skip threshold, the model decides add / update / contradict.' },
      { path: 'memory.supersedeThreshold', label: 'Supersede floor', type: 'number', min: 0, max: 1, step: 0.01,
        help: 'Below this, a fact is never considered a replacement for an existing one.' },
      { path: 'memory.supersedeScanLimit', label: 'Supersede scan limit', type: 'number', min: 1, max: 50, step: 1,
        help: 'How many similar facts to weigh when deciding what a new one replaces.' },
      { path: 'memory.minFactSimilarity', label: 'Minimum search similarity', type: 'number', min: 0, max: 1, step: 0.01,
        help: 'Facts below this never reach results at all.' },
      { path: 'memory.injectionFloor', label: 'Auto-injection floor', type: 'number', min: 0, max: 1, step: 0.01,
        help: 'The precision gate for unprompted recall injected into agent prompts. Higher means quieter but surer.' },
    ],
  },
  {
    id: 'search',
    title: 'Search',
    settings: [
      { path: 'search.synthesize', label: 'Synthesize an answer', type: 'boolean',
        help: 'Compose a written answer from the retrieved facts. Costs one model call per search.' },
      { path: 'search.synthesizeModel', label: 'Synthesis model', type: 'text', placeholder: '(provider default)',
        help: 'Leave blank to use the configured LLM model.' },
    ],
  },
  {
    id: 'engine',
    title: 'LLM engine',
    help: 'Warm workers keep `claude` alive in tmux so calls skip process startup. Pool changes need a daemon restart — the pool is built once at boot.',
    settings: [
      { path: 'llm.managedSession.enabled', label: 'Warm workers', type: 'boolean', restart: true,
        help: 'Keeps a pool of `claude` sessions alive instead of spawning one per call.' },
      { path: 'llm.managedSession.poolSize', label: 'Pool size', type: 'number', min: 1, max: 8, step: 1, restart: true,
        help: 'Workers per source type. They boot one after another, roughly 13s each.' },
      { path: 'llm.managedSession.tokenBudget', label: 'Token budget per worker', type: 'number', min: 10000, max: 500000, step: 10000, restart: true,
        help: 'A worker is recycled once it has spent this much context.' },
      { path: 'llm.managedSession.taskTimeoutMs', label: 'Task timeout (ms)', type: 'number', min: 10000, max: 600000, step: 5000, restart: true,
        help: 'A task silent for this long falls back to the one-shot path and the worker is recycled.' },
      { path: 'llm.managedSession.firstTaskTimeoutMs', label: 'Boot handshake window (ms)', type: 'number', min: 10000, max: 180000, step: 5000, restart: true,
        help: 'How long a new worker has to answer its first task before being recycled.' },
      { path: 'llm.managedSession.clearBetweenTasks', label: 'Clear context between tasks', type: 'boolean', restart: true,
        help: 'Off keeps conversation context across tasks — cheaper, but tasks can influence each other.' },
      { path: 'llm.maxClaudeProcs', label: 'Max concurrent claude processes', type: 'number', min: 1, max: 16, step: 1,
        help: 'Hard ceiling on live `claude` spawns. The gate that stops a runaway from opening hundreds.' },
      { path: 'llm.maxRetries', label: 'Retries', type: 'number', min: 0, max: 10, step: 1 },
      { path: 'llm.cliTimeout', label: 'CLI timeout (ms)', type: 'number', min: 10000, max: 600000, step: 10000 },
      { path: 'llm.requestTimeout', label: 'API request timeout (ms)', type: 'number', min: 5000, max: 300000, step: 5000 },
      { path: 'llm.extractionModel', label: 'Extraction model', type: 'text', placeholder: '(provider default)' },
      { path: 'llm.decisionModel', label: 'Decision model', type: 'text', placeholder: '(provider default)' },
      { path: 'llm.entityModel', label: 'Entity model', type: 'text', placeholder: '(provider default)' },
      { path: 'llm.cliPath', label: 'CLI path', type: 'text', placeholder: 'claude',
        help: 'Absolute path to the `claude` binary if it is not on PATH.' },
    ],
  },
  {
    id: 'hebbian',
    title: 'Co-retrieval learning',
    help: 'Entities retrieved together get a link that strengthens with use and decays with time, so the graph learns what actually goes together.',
    settings: [
      { path: 'hebbian.entity.enabled', label: 'Strengthen co-retrieved entities', type: 'boolean' },
      { path: 'hebbian.entity.halfLifeDays', label: 'Half-life (days)', type: 'number', min: 1, max: 365, step: 1,
        help: 'How long an unused link takes to lose half its strength.' },
      { path: 'hebbian.entity.eta', label: 'Strengthen step', type: 'number', min: 0.1, max: 10, step: 0.1,
        help: 'How much a single co-retrieval adds.' },
      { path: 'hebbian.entity.cap', label: 'Strength cap', type: 'number', min: 1, max: 500, step: 1 },
      { path: 'hebbian.entity.minEffective', label: 'Minimum useful strength', type: 'number', min: 0, max: 50, step: 0.1,
        help: 'Decayed links below this are ignored when ranking.' },
      { path: 'hebbian.entity.rrfWeight', label: 'Ranking weight', type: 'number', min: 0, max: 1, step: 0.05,
        help: 'How much co-retrieval history influences result order.' },
      { path: 'hebbian.entity.maxWriteEntities', label: 'Max entities strengthened per search', type: 'number', min: 2, max: 50, step: 1,
        help: 'Writes grow with the square of this, so it is deliberately small.' },
      { path: 'hebbian.entity.expandPerSeed', label: 'Expansion per seed', type: 'number', min: 0, max: 20, step: 1 },
    ],
  },
  {
    id: 'server',
    title: 'Server',
    help: 'The local HTTP surface this dashboard is served from. Changes need a daemon restart.',
    settings: [
      { path: 'http.enabled', label: 'HTTP server', type: 'boolean', restart: true },
      { path: 'http.host', label: 'Bind host', type: 'text', placeholder: '127.0.0.1', restart: true,
        help: 'Loopback by default. Binding beyond it exposes your memory to the network.' },
      { path: 'http.port', label: 'Port', type: 'number', min: 1024, max: 65535, step: 1, restart: true },
      { path: 'preferences.noUpdateCheck', label: 'Skip update checks', type: 'boolean' },
    ],
  },
  {
    id: 'output',
    title: 'Output',
    help: 'Where generated artifacts are written.',
    settings: [
      { path: 'output.storage', label: 'Storage', type: 'enum', options: ['local', 's3'] },
      { path: 'output.dir', label: 'Local directory', type: 'text', placeholder: './output' },
      { path: 'output.s3.endpoint', label: 'S3 endpoint', type: 'text', placeholder: 'https://s3.amazonaws.com' },
      { path: 'output.s3.bucket', label: 'S3 bucket', type: 'text' },
      { path: 'output.s3.region', label: 'S3 region', type: 'text', placeholder: 'us-east-1' },
      { path: 'output.s3.publicUrl', label: 'S3 public URL', type: 'text' },
    ],
  },
];

/** Flat path → definition, for validating a write. */
export const SETTINGS_BY_PATH = new Map(
  SETTINGS_SECTIONS.flatMap((s) => s.settings.map((d) => [d.path, { ...d, section: s.id }])),
);

/** Read a dotted path out of a config object. */
export function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Coerce and bounds-check one value against its definition.
 * Returns { ok, value } or { ok:false, error } — never throws, so a bad field
 * reports itself rather than failing the whole save.
 */
export function coerce(def, raw) {
  if (!def) return { ok: false, error: 'unknown setting' };
  if (def.type === 'boolean') return { ok: true, value: Boolean(raw) };
  if (def.type === 'enum') {
    const v = String(raw);
    return def.options.includes(v) ? { ok: true, value: v } : { ok: false, error: `must be one of ${def.options.join(', ')}` };
  }
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: 'must be a number' };
    if (def.min != null && n < def.min) return { ok: false, error: `must be ≥ ${def.min}` };
    if (def.max != null && n > def.max) return { ok: false, error: `must be ≤ ${def.max}` };
    return { ok: true, value: n };
  }
  // text — empty string means "unset", which is how the defaults express it.
  return { ok: true, value: raw == null ? '' : String(raw) };
}
