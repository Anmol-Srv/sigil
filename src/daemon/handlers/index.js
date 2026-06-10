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
import { registerIngestTurn } from './ingest-turn.js';
import { registerEndSession } from './end-session.js';
import { registerSearch } from './search.js';
import { registerStatus } from './status.js';
import { registerSearchEntity } from './search-entity.js';
import { registerTraverseGraph } from './traverse-graph.js';
import { registerGetFactContext } from './get-fact-context.js';
import { registerGetEntityContext } from './get-entity-context.js';
import { registerGetPod } from './get-pod.js';
import { registerListPods } from './list-pods.js';
import { registerIngestDoc } from './ingest-doc.js';
import { registerListFacts } from './list-facts.js';
import { registerGraphSnapshot } from './graph-snapshot.js';
import { registerForgetFact } from './forget-fact.js';
import { registerRefreshContext } from './refresh-context.js';
import { registerTestDbConnection } from './test-db-connection.js';
import { registerRunMigrations } from './run-migrations.js';
import { registerEnsurePgvector } from './ensure-pgvector.js';
import { registerConnectors } from './connectors.js';
import { registerSupervisor } from './supervisor.js';
import { registerNodeInfo } from './node-info.js';
import { registerPair } from './pair.js';
import { registerMode } from './mode.js';
import { registerManifest } from './manifest.js';
import { registerDevice } from './device.js';
import { registerTrace } from './trace.js';
import { registerSetup } from './setup.js';
import { registerRepair } from './repair.js';
import { registerLlmLog } from './llm-log.js';

export function registerAll(registry, { startedAt }) {
  registerPing(registry, { startedAt });
  registerRemember(registry);
  registerIngestTurn(registry);
  registerEndSession(registry);
  registerSearch(registry);
  registerStatus(registry);
  registerSearchEntity(registry);
  registerTraverseGraph(registry);
  registerGetFactContext(registry);
  registerGetEntityContext(registry);
  registerGetPod(registry);
  registerListPods(registry);
  registerIngestDoc(registry);
  registerListFacts(registry);
  registerGraphSnapshot(registry);
  registerForgetFact(registry);
  registerRefreshContext(registry);
  registerTestDbConnection(registry);
  registerRunMigrations(registry);
  registerEnsurePgvector(registry);
  registerConnectors(registry);
  registerSupervisor(registry);
  registerNodeInfo(registry);
  registerPair(registry);
  registerMode(registry);
  registerManifest(registry);
  registerDevice(registry);
  registerTrace(registry);
  registerSetup(registry);
  registerRepair(registry);
  registerLlmLog(registry);
}
