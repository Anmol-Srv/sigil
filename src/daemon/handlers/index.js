/**
 * Bulk registration. Keeps src/daemon/index.js focused on lifecycle
 * rather than 22 individual register* calls in declaration order.
 * PR review #27.
 *
 * Order matters only for ping (relies on startedAt); everything else
 * is order-independent.
 */
import { registerPing } from './ping.js';
import { registerRemember } from './remember.js';
import { registerSearch } from './search.js';
import { registerStatus } from './status.js';
import { registerGetFactContext } from './get-fact-context.js';
import { registerIngestDoc } from './ingest-doc.js';
import { registerListFacts } from './list-facts.js';
import { registerForgetFact } from './forget-fact.js';
import { registerCorrectFact } from './correct-fact.js';
import { registerRunMigrations } from './run-migrations.js';
import { registerConnectors } from './connectors.js';
import { registerSupervisor } from './supervisor.js';
import { registerTrace } from './trace.js';
import { registerSetup } from './setup.js';
import { registerRepair } from './repair.js';
import { registerManageMemory } from './manage-memory.js';
import { registerRecall } from './recall.js';

export function registerAll(registry, { startedAt }) {
  registerPing(registry, { startedAt });
  registerRemember(registry);
  registerSearch(registry);
  registerStatus(registry);
  registerGetFactContext(registry);
  registerIngestDoc(registry);
  registerListFacts(registry);
  registerForgetFact(registry);
  registerCorrectFact(registry);
  registerRunMigrations(registry);
  registerConnectors(registry);
  registerSupervisor(registry);
  registerTrace(registry);
  registerSetup(registry);
  registerRepair(registry);
  registerManageMemory(registry);
  registerRecall(registry);
}
