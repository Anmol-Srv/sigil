/**
 * Runtime-only automatic-recall observability.
 *
 * Automatic recall must remain a read-only database operation. Persisting a
 * trace row on every prompt would turn the hot path into a write amplifier and
 * recreate the performance problem Sigil was designed to avoid. This small,
 * bounded in-memory ledger instead answers the operational question the GUI
 * needs: did a trusted prompt hook run, when, for which client, and did it
 * find any facts? It deliberately never stores prompts, fact content, or IDs.
 */

const MAX_EVENTS = 100;
const events = [];
const startedAt = new Date().toISOString();

function cleanAgent(agent) {
  const value = String(agent || 'unknown').trim();
  return value ? value.slice(0, 80) : 'unknown';
}

function cleanNamespace(namespace) {
  const value = String(namespace || 'default').trim();
  return value ? value.slice(0, 120) : 'default';
}

export function recordPromptRecall({ agent, namespace, resultCount, durationMs } = {}) {
  const matches = Math.max(0, Math.trunc(Number(resultCount) || 0));
  const duration = Math.max(0, Math.trunc(Number(durationMs) || 0));
  const event = {
    ts: new Date().toISOString(),
    agent: cleanAgent(agent),
    namespace: cleanNamespace(namespace),
    outcome: matches > 0 ? 'matched' : 'no_match',
    resultCount: matches,
    durationMs: duration,
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  return event;
}

export function recallStatus({ agent = null, limit = 20 } = {}) {
  const requestedAgent = agent ? cleanAgent(agent) : null;
  const matching = requestedAgent ? events.filter((event) => event.agent === requestedAgent) : events;
  const take = Math.min(Math.max(Math.trunc(Number(limit) || 20), 1), MAX_EVENTS);
  const byAgent = new Map();

  for (const event of matching) {
    if (!byAgent.has(event.agent)) {
      byAgent.set(event.agent, {
        agent: event.agent,
        attempts: 0,
        matched: 0,
        noMatch: 0,
        last: event,
      });
    }
    const summary = byAgent.get(event.agent);
    summary.attempts += 1;
    if (event.outcome === 'matched') summary.matched += 1;
    else summary.noMatch += 1;
  }

  return {
    persistence: 'runtime-only',
    startedAt,
    capacity: MAX_EVENTS,
    recent: matching.slice(0, take),
    agents: [...byAgent.values()],
  };
}

export function resetRecallObservatoryForTests() {
  events.length = 0;
}
