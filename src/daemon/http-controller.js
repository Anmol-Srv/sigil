/**
 * Lazy owner for the local browser server.
 *
 * The core daemon serves Unix-socket RPC without importing `ws` or binding a TCP
 * port. Opening the GUI explicitly calls `start()`, which loads the HTTP module
 * once and keeps it alive until daemon shutdown.
 */
export function createHttpController({
  registry,
  log,
  config,
  loadServer = () => import('./http-server.js'),
}) {
  let active = null;
  let starting = null;

  async function start() {
    if (active) return { started: false, url: active.url };
    if (!starting) {
      starting = (async () => {
        const { startHttpServer } = await loadServer();
        active = await startHttpServer({ registry, log, config });
        return active;
      })().finally(() => {
        starting = null;
      });
    }
    const server = await starting;
    return { started: true, url: server.url };
  }

  async function close() {
    if (starting) await starting.catch(() => {});
    const server = active;
    active = null;
    if (server) await server.close();
  }

  function status() {
    return { running: Boolean(active), url: active?.url || null };
  }

  return { start, close, status };
}
