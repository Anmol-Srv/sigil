/**
 * manifest.get / manifest.verify — produce or compare schema manifests.
 *
 *   manifest.get               returns this device's manifest
 *   manifest.verify({ remote }) checks remote against this device's
 *                               local manifest and returns ok/errors/warnings
 */
export function registerManifest(registry) {
  registry.register('manifest.get', async () => {
    const { produceManifest } = await import('../../memory/manifest.js');
    return produceManifest();
  });

  registry.register('manifest.verify', async (params) => {
    const { produceManifest, verifyManifest } = await import('../../memory/manifest.js');
    const local = await produceManifest();
    return verifyManifest(local, params.remote);
  });
}
