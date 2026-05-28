/**
 * nodeInfo — return this device's Iroh identity and connectivity status.
 * Returns null fields if Iroh is disabled (SIGIL_MODE=solo and no explicit
 * SIGIL_NETWORK_ENABLED override).
 */
export function registerNodeInfo(registry) {
  registry.register('nodeInfo', async () => {
    const { default: config } = await import('../../config.js');
    if (!config.network.enabled) {
      return { enabled: false, mode: config.network.mode };
    }
    const { getNodeInfo } = await import('../../net/endpoint.js');
    try {
      const info = await getNodeInfo();
      return { enabled: true, mode: config.network.mode, ...info };
    } catch (err) {
      return { enabled: true, mode: config.network.mode, error: err.message };
    }
  });
}
