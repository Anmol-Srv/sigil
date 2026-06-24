/**
 * Small, dependency-free string helpers shared across subsystems.
 */

/**
 * Escape a string for safe interpolation into a `new RegExp(...)` pattern.
 * Escapes every character with special meaning in a regex.
 */
export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
