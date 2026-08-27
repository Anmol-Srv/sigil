/**
 * Built-in pod kind registration.
 *
 * Importing this module registers all 0.10.0 built-in kinds with the
 * pod kind registry. Code that wants the registry populated should
 * import this once near startup; downstream callers then use
 * `import { get, list, activeKinds } from './registry.js'`.
 *
 * Idempotent — registering the same kind twice is a no-op (overwrites
 * the prior entry with the same contract). The CLI startup path
 * (src/cli.js) and the MCP server entry point both import this.
 */

import { register } from '../registry.js';

import { claudeSessionKind } from './claude_session.js';
import { directiveKind } from './directive.js';
import { hermesProfileKind } from './hermes_profile.js';
import { personKind } from './person.js';
import { projectKind } from './project.js';
import { playbookKind } from './playbook.js';
import { vitalKind } from './vital.js';

// Order is the hot-context blend order (getHotFacts merges kind lists in
// registration order until the overall limit fills). directive goes FIRST:
// standing instructions about how to work with the user are the one class of
// fact that query-driven recall can never surface on its own, so they get the
// scarcest slots before project pods or vital can claim them.
const BUILTINS = [
  directiveKind,
  claudeSessionKind,
  projectKind,
  personKind,
  playbookKind,
  hermesProfileKind,
  vitalKind,
];

let registered = false;

export function registerBuiltins() {
  if (registered) return;
  for (const kind of BUILTINS) {
    register(kind);
  }
  registered = true;
}

registerBuiltins();
