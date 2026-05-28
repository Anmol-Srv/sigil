/**
 * mode — return this device's network mode + the MemoryClient kind that
 * would handle a memory operation right now. Useful for the GUI and
 * for diagnosing lite-follower vs local-DB confusion.
 */
export function registerMode(registry) {
  registry.register('mode', async () => {
    const { default: config } = await import('../../config.js');
    const { getMemoryClient } = await import('../../memory/client.js');
    let clientKind = 'unknown';
    let clientError = null;
    try {
      const c = await getMemoryClient();
      clientKind = c.kind;
    } catch (err) { clientError = err.message; }
    return {
      mode: config.network.mode,
      networkEnabled: config.network.enabled,
      masterNodeId: config.network.masterNodeId,
      memoryClient: clientKind,
      memoryClientError: clientError,
    };
  });
}
