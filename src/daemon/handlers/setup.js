/**
 * Setup RPCs — the GUI's door into the native first-run setup service.
 * Progress streams over the /api/v1/events WebSocket as { type:'setup', … };
 * these RPCs just kick off work and report state.
 */
import { getSetupState, getSetupConfig, listSteps, detectStep, runStep, factoryResetSetup, disableLlm } from '../../setup/service.js';

export function registerSetup(registry) {
  registry.register('setup.state', async () => getSetupState());
  registry.register('setup.config', async () => getSetupConfig());
  registry.register('setup.steps', async () => ({ steps: listSteps() }));
  registry.register('setup.detect', async (params = {}) => detectStep(params.step));
  registry.register('setup.run', async (params = {}) => runStep(params.step, params.input || {}));
  registry.register('setup.disableLlm', async (params = {}) => {
    if (params.confirm !== true) {
      const err = new Error('setup.disableLlm: params.confirm must be true');
      err.code = 'confirmation_required';
      throw err;
    }
    return disableLlm();
  });
  registry.register('setup.factoryReset', async (params = {}) => {
    if (params.confirm !== true) {
      const err = new Error('setup.factoryReset: params.confirm must be true');
      err.code = 'confirmation_required';
      throw err;
    }
    return factoryResetSetup({ wipeMemory: params.wipeMemory !== false });
  });
}
