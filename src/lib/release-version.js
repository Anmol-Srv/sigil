/**
 * Release versioning for CI (.github/workflows/release.yml).
 *
 * npm and the git `release` branch get the SAME version on every release. npm
 * can't publish a version twice, so each release needs a fresh number:
 *   - package.json on master holds the base (bump it by hand for a minor/major);
 *   - if the base is newer than everything already released, release the base;
 *   - otherwise release the next patch after the newest released version.
 */
import { compareVersions } from './npm-door.js';

/**
 * @param {string} base         version in package.json on master
 * @param {string[]} released   versions already out (npm + git tags); may be empty
 * @returns {string}
 */
export function nextReleaseVersion(base, released = []) {
  const valid = released.filter((v) => /^v?\d+\.\d+\.\d+$/.test(String(v || '').trim()));
  const newest = valid.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), null);
  if (!newest || compareVersions(base, newest) > 0) return base.replace(/^v/, '');
  const [maj, min, pat] = newest.replace(/^v/, '').split('.').map(Number);
  return `${maj}.${min}.${pat + 1}`;
}
