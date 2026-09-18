import { getConfig, patchConfig } from '../../setup/config-store.js';
import { DEFAULT_MODEL, probeJev } from '../../lib/jev.js';

function publicStatus(config = getConfig()) {
  const jev = config.jev || {};
  const configured = Boolean(jev.apiKey);
  return {
    enabled: jev.enabled === true,
    configured,
    ready: configured && jev.enabled === true,
    model: jev.model || DEFAULT_MODEL,
    maxCandidates: jev.maxCandidates ?? 12,
    minScore: jev.minScore ?? 0.55,
    injectionMax: jev.injectionMax ?? 0.7,
    timeoutMs: jev.timeoutMs ?? 10_000,
  };
}

/**
 * Jev credentials have a dedicated write path: the generic settings setter is
 * intentionally secret-free. No handler response ever echoes the credential.
 *
 * The key is verified before it is stored. Saving an unverified key is how a
 * typo becomes a silent `reason: 'unavailable'` fallback on every later search
 * — the user sees "saved", the feature never runs, and nothing says why. A
 * rejected credential is refused outright; a network failure saves with
 * `verified: false` so an offline setup still works.
 */
export function registerJev(registry, { probeImpl = probeJev } = {}) {
  registry.register('jev.status', async () => publicStatus());

  registry.register('jev.configure', async (params = {}) => {
    const apiKey = typeof params.apiKey === 'string' ? params.apiKey.trim() : '';
    if (!apiKey) {
      const error = new Error('A Jev API key is required.');
      error.code = 'invalid_params';
      throw error;
    }

    const current = getConfig().jev || {};
    const model = typeof params.model === 'string' && params.model.trim()
      ? params.model.trim().slice(0, 100)
      : current.model || DEFAULT_MODEL;

    let verified = false;
    let warning = null;
    try {
      await probeImpl({ apiKey, model, timeoutMs: current.timeoutMs || 10_000 });
      verified = true;
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        const error = new Error('Jev rejected that API key. Nothing was saved.');
        error.code = 'invalid_params';
        error.hint = 'Check the key at typesafe.ai and paste it again.';
        throw error;
      }
      warning = `Key saved, but it could not be verified right now (${String(err?.message || 'network error').slice(0, 120)}).`;
    }

    patchConfig('jev', { ...current, apiKey, model });
    // config-store writes synchronously in production; construct the response
    // from the accepted values too, so callers never see a stale "not
    // configured" state even when a test/store adapter batches persistence.
    return {
      ...publicStatus({ ...getConfig(), jev: { ...current, apiKey, model } }),
      saved: true,
      verified,
      warning,
    };
  });
}

export { publicStatus };
