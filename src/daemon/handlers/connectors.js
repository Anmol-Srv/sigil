/**
 * Connectors RPC — GUI-facing wrapper over the client registry
 * (src/lib/clients/*). Lets the dashboard render agent cards and connect,
 * repair or disconnect Sigil in Claude Code, Codex, Cursor, Kiro and Hermes.
 *
 * Each row carries `state` (working | waiting | needs-repair | available |
 * unavailable — see src/lib/clients/status.js) plus the evidence behind it.
 * `status` (connected | available | unavailable) is kept for older callers.
 */
import { listClients } from '../../lib/clients/index.js';
import { listConnectorStatus } from '../../lib/clients/status.js';
import { AppError } from '../../lib/errors.js';

function legacyStatus(state) {
  if (state === 'working' || state === 'waiting') return 'connected';
  if (state === 'unavailable') return 'unavailable';
  return 'available';
}

async function findClient(id) {
  const clients = await listClients();
  const client = clients.find((c) => c.id === id);
  if (!client) {
    const err = new AppError({ errorCode: 'VALIDATION_ERROR', message: `unknown connector: ${id}` });
    throw err;
  }
  return client;
}

export function registerConnectors(registry) {
  registry.register('listConnectors', async () => {
    const rows = await listConnectorStatus(await listClients());
    return { connectors: rows.map((r) => ({ ...r, status: legacyStatus(r.state) })) };
  });

  // Install Sigil into a client, then verify it actually took.
  registry.register('connectConnector', async (params = {}) => {
    const client = await findClient(params.id);
    let actions = [];
    try {
      const res = await client.install({ dryRun: false });
      actions = res?.actions || [];
    } catch (err) {
      throw new AppError({ errorCode: 'CONNECTOR_INSTALL_FAILED', message: err?.message, data: { id: client.id } });
    }
    const verified = await Promise.resolve()
      .then(() => client.verify())
      .catch((e) => ({ installed: false, reason: e?.message }));
    if (!verified?.installed) {
      throw new AppError({
        errorCode: 'CONNECTOR_VERIFY_FAILED',
        hint: verified?.reason || undefined,
        data: { id: client.id, reason: verified?.reason || null },
      });
    }
    return { ok: true, id: client.id, status: 'connected', actions };
  });

  registry.register('disconnectConnector', async (params = {}) => {
    const client = await findClient(params.id);
    let actions = [];
    try {
      const res = await client.uninstall({ dryRun: false });
      actions = res?.actions || [];
    } catch (err) {
      throw new AppError({ errorCode: 'CONNECTOR_INSTALL_FAILED', message: err?.message, data: { id: client.id } });
    }
    return { ok: true, id: client.id, status: 'available', actions };
  });
}
