/**
 * Turn a local client's optional project identity into namespace choices.
 *
 * Explicit API namespaces always win. Automatic project selection is only for
 * ordinary agent/CLI calls, where it gives the useful default of project-first
 * retrieval with the long-lived local `default` namespace as a fallback.
 */
import config from '../config.js';
import { isProjectNamespace } from '../lib/project-scope.js';

export function resolveMemoryScope(params = {}, ctx = {}) {
  const explicit = normalizeNamespaces(params.namespaces);
  if (explicit.length) {
    return {
      mode: 'explicit',
      writeNamespace: normalizeNamespace(params.namespace) || explicit[0],
      namespaces: explicit,
      namespaceTiers: [explicit],
    };
  }

  const explicitNamespace = normalizeNamespace(params.namespace);
  if (explicitNamespace) {
    return {
      mode: 'explicit',
      writeNamespace: explicitNamespace,
      namespaces: [explicitNamespace],
      namespaceTiers: [[explicitNamespace]],
    };
  }

  const projectNamespace = isProjectNamespace(ctx?.scope?.projectNamespace)
    ? ctx.scope.projectNamespace
    : null;
  const sharedNamespace = config.defaults.namespace;
  if (projectNamespace && projectNamespace !== sharedNamespace) {
    return {
      mode: 'project',
      writeNamespace: projectNamespace,
      namespaces: [projectNamespace, sharedNamespace],
      namespaceTiers: [[projectNamespace], [sharedNamespace]],
    };
  }

  return {
    mode: 'shared',
    writeNamespace: sharedNamespace,
    namespaces: [sharedNamespace],
    namespaceTiers: [[sharedNamespace]],
  };
}

function normalizeNamespaces(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeNamespace).filter(Boolean))];
}

function normalizeNamespace(value) {
  const namespace = typeof value === 'string' ? value.trim() : '';
  return namespace || null;
}
