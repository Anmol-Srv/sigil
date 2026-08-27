/**
 * Community detection + anchor placement for the graph view.
 *
 * The graph was one dense glob for two separate reasons, and this fixes both:
 *
 *   1. Every connected component was pulled to the SAME origin by forceX(0)/
 *      forceY(0), so 78 components stacked on top of each other. Giving each
 *      community its own anchor is what un-stacks them.
 *   2. The giant component (59% of nodes on a real store) had no internal
 *      structure to show. Louvain finds it from the link topology alone.
 *
 * Communities are expressed through SPACE first — each gets its own anchor —
 * and colour second. Colour was reassigned from --etype-* to cluster because the
 * type channel is near-constant on a real store (301 topics vs 1 person), so it
 * spent the whole budget saying nothing. Only the top regions get a hue; minor
 * and unconnected clusters stay neutral, which keeps the canvas from becoming
 * the "multi-color" decoration DESIGN.md rules out.
 *
 * Deterministic by construction — nodes are visited in a canonical id order and
 * there is no RNG anywhere, so the same store always lays out the same way even
 * if the caller hands the nodes over in a different order. A graph that
 * reshuffles itself on every reload is worse than one that is merely dense.
 *
 * ponytail: hand-rolled Louvain rather than graphology + graphology-communities-
 * louvain, which would add ~80KB to a 382KB bundle to cluster ~500 nodes. If the
 * communities ever come out unstable or poorly separated, swapping the library
 * in behind clusterGraph()'s signature is the upgrade path.
 */

import { schemeSet3 } from 'd3-scale-chromatic';

/** Cluster id for nodes with no edges at all — they share one parked bucket. */
export const UNCONNECTED = -1;

/**
 * Cluster id for every community too small to deserve its own place on the
 * canvas. Giving all 53 communities an anchor scattered 40-odd two-node
 * fragments across the whole viewport at radius 1000+, which reads as noise:
 * a 3-node fragment is not a region of your knowledge, it is a loose end.
 * They all share one anchor and settle as a single outlying group.
 */
export const MINOR = -2;

/**
 * Region colour comes from d3-scale-chromatic, which force-graph already
 * depends on — so this costs nothing and replaces ~30 lines of hand-rolled HSL.
 *
 * force-graph has `nodeAutoColorBy`, which does exactly this job. It is not
 * used here for two specific reasons: its scale is hardcoded to schemePaired,
 * a LIGHT-background ColorBrewer set whose #6a3d9a only reaches 2.56:1 on our
 * near-black canvas, and it would colour the parked groups too, when grey is
 * doing real work as "too few links to be a region".
 *
 * schemeSet3 instead: of the qualitative schemes shipped here it is the only
 * one where all twelve clear 3:1 against --bg-1. Its own grey (#d9d9d9) is
 * dropped, since grey is reserved.
 *
 * No qualitative palette separates every pair at eleven categories — the
 * validator rejects all of them, ColorBrewer included. Spatial separation and
 * the hub labels are what carry identity; colour marks the boundaries.
 */
const REGION_SCHEME = schemeSet3.filter((c) => c !== '#d9d9d9');

/**
 * Colours for n regions, by rank. Keyed to rank, not to n, so gaining a region
 * never repaints the others. Cycles if a graph somehow exceeds the scheme.
 */
export function regionShades(n) {
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => REGION_SCHEME[i % REGION_SCHEME.length]);
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const EPS = 1e-12;

/** Weighted adjacency + self-loop weights for one level of the hierarchy. */
function buildAdjacency(size, edges) {
  const adj = Array.from({ length: size }, () => new Map());
  const self = new Float64Array(size);
  for (const [a, b, w] of edges) {
    if (a === b) { self[a] += w; continue; }
    adj[a].set(b, (adj[a].get(b) || 0) + w);
    adj[b].set(a, (adj[b].get(a) || 0) + w);
  }
  return { adj, self };
}

/** k_i — weighted degree, self-loops counted twice as the modularity math wants. */
function weightedDegrees(adj, self) {
  return adj.map((neighbours, i) => {
    let k = 2 * self[i];
    for (const w of neighbours.values()) k += w;
    return k;
  });
}

/**
 * Louvain phase 1. Each node starts alone, then repeatedly moves to whichever
 * neighbouring community yields the largest modularity gain:
 *
 *   ΔQ ∝ k_i,in − (Σ_tot · k_i) / 2m
 *
 * Ties break toward the lower community index so the result cannot depend on
 * Map iteration order.
 */
function localMoving(adj, self, k, m2) {
  const size = adj.length;
  const community = new Int32Array(size);
  const sigmaTot = Float64Array.from(k);
  for (let i = 0; i < size; i++) community[i] = i;

  for (let pass = 0; pass < 20; pass++) {
    let moved = 0;
    for (let i = 0; i < size; i++) {
      const from = community[i];
      const linksTo = new Map();
      for (const [j, w] of adj[i]) {
        const cj = community[j];
        linksTo.set(cj, (linksTo.get(cj) || 0) + w);
      }

      // Pull i out of its community BEFORE scoring, so staying put is judged on
      // the same footing as every alternative.
      sigmaTot[from] -= k[i];
      let best = from;
      let bestGain = (linksTo.get(from) || 0) - (sigmaTot[from] * k[i]) / m2;
      for (const [c, w] of linksTo) {
        if (c === from) continue;
        const gain = w - (sigmaTot[c] * k[i]) / m2;
        if (gain > bestGain + EPS || (Math.abs(gain - bestGain) <= EPS && c < best)) {
          best = c;
          bestGain = gain;
        }
      }
      sigmaTot[best] += k[i];
      if (best !== from) { community[i] = best; moved++; }
    }
    if (!moved) break;
  }
  return community;
}

/** Compact community ids to 0..n-1, preserving first-seen order. */
function renumber(community) {
  const seen = new Map();
  const out = new Int32Array(community.length);
  for (let i = 0; i < community.length; i++) {
    const c = community[i];
    if (!seen.has(c)) seen.set(c, seen.size);
    out[i] = seen.get(c);
  }
  return { compact: out, count: seen.size };
}

/** Louvain phase 2 — collapse each community into a single node. */
function aggregate(edges, compact) {
  const merged = new Map();
  for (const [a, b, w] of edges) {
    const ca = compact[a];
    const cb = compact[b];
    const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    merged.set(key, (merged.get(key) || 0) + w);
  }
  return [...merged].map(([key, w]) => {
    const [a, b] = key.split('|');
    return [Number(a), Number(b), w];
  });
}

/** Full Louvain: local moving, then aggregate, until a level stops merging. */
function louvain(size, edges) {
  let membership = Array.from({ length: size }, (_, i) => i);
  let levelSize = size;
  let levelEdges = edges;

  for (let level = 0; level < 12; level++) {
    const { adj, self } = buildAdjacency(levelSize, levelEdges);
    const k = weightedDegrees(adj, self);
    const m2 = k.reduce((a, b) => a + b, 0);
    if (!m2) break;

    const { compact, count } = renumber(localMoving(adj, self, k, m2));
    if (count === levelSize) break; // nothing merged — modularity has converged

    membership = membership.map((c) => compact[c]);
    levelEdges = aggregate(levelEdges, compact);
    levelSize = count;
  }
  return membership;
}

/**
 * Cluster a node/edge set and hand back both the per-node assignment and the
 * anchor each cluster should be pulled toward.
 *
 * Anchors sit on a phyllotaxis spiral: the largest cluster takes the origin and
 * the rest fan outward, which keeps the mass centred (so zoomToFit still frames
 * well) while guaranteeing no two clusters share a target. The unconnected
 * bucket is forced outermost — 39 lonely nodes have no business competing for
 * the middle with a real community.
 */
export function clusterGraph(nodes, edges, opts = {}) {
  const spread = opts.spread ?? 150;
  // Louvain's result depends on the order nodes are visited, and the caller's
  // order is NOT stable — graphSnapshot's entity query has no ORDER BY, so the
  // DB may hand back rows differently between loads. Sorting by id here makes
  // the clustering a function of the graph alone, so the same store lays out
  // the same way every time regardless of who assembled the input.
  const ordered = [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const index = new Map(ordered.map((n, i) => [n.id, i]));
  const degree = new Array(ordered.length).fill(0);
  const pairs = [];

  for (const e of edges) {
    // force-graph rewrites link.source/target from an id into the node object
    // once the simulation starts, so accept either shape.
    const a = index.get(e.source?.id ?? e.source);
    const b = index.get(e.target?.id ?? e.target);
    if (a === undefined || b === undefined || a === b) continue;
    pairs.push([a, b, 1]);
    degree[a] += 1;
    degree[b] += 1;
  }

  const membership = pairs.length ? louvain(ordered.length, pairs) : [];

  const assignment = new Map();
  const members = new Map();
  ordered.forEach((n, i) => {
    const id = degree[i] === 0 ? UNCONNECTED : membership[i];
    assignment.set(n.id, id);
    if (!members.has(id)) members.set(id, []);
    members.get(id).push(n);
  });

  // Biggest first so the densest community wins the centre; the parked buckets
  // are last regardless of how many strays they hold.
  const parked = (id) => id === UNCONNECTED || id === MINOR;
  let ranked = [...members.entries()].sort((x, y) => {
    if (parked(x[0]) && !parked(y[0])) return 1;
    if (parked(y[0]) && !parked(x[0])) return -1;
    return y[1].length - x[1].length || x[0] - y[0];
  });

  // Only communities that are actually substantial get their own anchor. The
  // floor scales with the graph so a small store doesn't fold everything into
  // one blob, and the cap stops a huge store from sprouting 30 regions.
  const minMajor = opts.minMajorSize ?? Math.max(4, Math.round(ordered.length * 0.02));
  const maxMajor = opts.maxMajors ?? 12;
  const minors = [];
  const majors = [];
  for (const entry of ranked) {
    const [id, group] = entry;
    if (!parked(id) && group.length >= minMajor && majors.length < maxMajor) majors.push(entry);
    else if (parked(id)) majors.push(entry);
    else minors.push(entry);
  }
  if (minors.length) {
    const folded = minors.flatMap(([, group]) => group);
    for (const n of folded) assignment.set(n.id, MINOR);
    // Re-rank with the folded group in place, keeping parked buckets last.
    ranked = [...majors.filter(([id]) => !parked(id)),
      [MINOR, folded],
      ...majors.filter(([id]) => parked(id))];
  } else {
    ranked = majors;
  }

  const clusters = ranked.map(([id, group], i) => {
    const radius = spread * Math.sqrt(i);
    const angle = i * GOLDEN_ANGLE;
    const label = id === MINOR || id === UNCONNECTED ? null : clusterLabel(group);
    return {
      id,
      size: group.length,
      unconnected: id === UNCONNECTED,
      minor: id === MINOR,
      x: Math.round(Math.cos(angle) * radius),
      y: Math.round(Math.sin(angle) * radius),
      label,
      // Filled in from the shade ramp below. Grey is reserved for the two
      // parked groups — it means "too few links to be a region", which is the
      // only thing it should ever have meant.
      color: null,
    };
  });
  const regions = clusters.filter((c) => !c.minor && !c.unconnected);
  const shades = regionShades(regions.length);
  regions.forEach((c, i) => { c.color = shades[i]; });

  return { assignment, clusters };
}

/**
 * A cluster is named after its best-connected ENTITY. Facts are excluded: a
 * fact's label is a whole sentence, which reads as noise at cluster scale.
 */
function clusterLabel(group) {
  let best = null;
  for (const n of group) {
    if (n.kind !== 'entity') continue;
    if (!best || (n.degree || 0) > (best.degree || 0)) best = n;
  }
  return best?.label ?? null;
}
