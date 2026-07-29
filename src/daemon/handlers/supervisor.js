/**
 * Supervisor RPCs — let the GUI (finish step / Settings) install the always-up
 * OS service and read its status. The daemon runs as the user, so it can run
 * launchctl/systemctl/schtasks on their behalf.
 */
import {
  installServiceUnit, uninstallService, restartService, serviceStatus,
} from '../../supervisor/index.js';
import { getDbHealth } from '../registry-holder.js';

export function registerSupervisor(registry) {
  registry.register('serviceStatus', async () => {
    const status = await serviceStatus();
    return { ...status, db: getDbHealth?.() ?? null };
  });

  // Install the unit, then hand off: this daemon steps down so the OS
  // service's KeepAlive/Restart brings up a fresh supervised instance that
  // binds the socket. The 400ms delay lets this RPC's response flush to the
  // GUI first; then we raise SIGTERM on ourselves so the real shutdown hooks
  // run (drain socket + HTTP, destroy the pool, remove the pidfile) instead
  // of a hard process.exit(0) that leaks all of that and races teardown.
  registry.register('serviceInstall', async () => {
    const res = await installServiceUnit();
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 400).unref?.();
    return { ok: true, handingOff: true, ...res };
  });

  registry.register('serviceUninstall', async () => {
    const res = await uninstallService();
    return { ok: true, ...res };
  });

  registry.register('serviceRestart', async () => {
    const status = await serviceStatus();
    if (!status.supervisor?.installed) {
      const err = new Error('Automatic start is not enabled yet. Enable it before restarting the managed service.');
      err.code = 'service_not_installed';
      throw err;
    }
    const res = await restartService();
    if (!res.ok) {
      const err = new Error(`Could not restart the ${res.manager || 'managed'} service.`);
      err.code = 'service_restart_failed';
      throw err;
    }
    return res;
  });
}
