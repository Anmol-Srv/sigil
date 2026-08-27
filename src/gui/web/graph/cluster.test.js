import { describe, it, expect } from 'vitest';

import { clusterGraph, UNCONNECTED, MINOR, regionShades } from './cluster.js';

const entity = (id, label) => ({ id, kind: 'entity', label, entityType: 'topic' });
const link = (source, target) => ({ source, target });

/** Two 4-cliques joined by a single bridge — the textbook community case. */
function twoCliques() {
  const nodes = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'].map((id) => entity(id, id));
  const edges = [];
  for (const g of [['a1', 'a2', 'a3', 'a4'], ['b1', 'b2', 'b3', 'b4']]) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) edges.push(link(g[i], g[j]));
    }
  }
  edges.push(link('a1', 'b1')); // the bridge
  return { nodes, edges };
}

describe('clusterGraph', () => {
  it('separates two cliques joined by one bridge', () => {
    const { nodes, edges } = twoCliques();
    const { assignment } = clusterGraph(nodes, edges);

    const a = assignment.get('a1');
    const b = assignment.get('b1');
    expect(a).not.toBe(b);
    for (const id of ['a2', 'a3', 'a4']) expect(assignment.get(id)).toBe(a);
    for (const id of ['b2', 'b3', 'b4']) expect(assignment.get(id)).toBe(b);
  });

  it('buckets every isolated node into one shared cluster, not one each', () => {
    const { nodes, edges } = twoCliques();
    const lonely = ['x1', 'x2', 'x3'].map((id) => entity(id, id));
    const { assignment, clusters } = clusterGraph([...nodes, ...lonely], edges);

    for (const id of ['x1', 'x2', 'x3']) expect(assignment.get(id)).toBe(UNCONNECTED);
    const bucket = clusters.find((c) => c.id === UNCONNECTED);
    expect(bucket.size).toBe(3);
    expect(bucket.unconnected).toBe(true);
  });

  it('is deterministic — a reload must not reshuffle the layout', () => {
    const { nodes, edges } = twoCliques();
    const a = clusterGraph(nodes, edges);
    const b = clusterGraph(nodes, edges);

    expect([...a.assignment.entries()]).toEqual([...b.assignment.entries()]);
    expect(a.clusters).toEqual(b.clusters);
  });

  it('is invariant to node order — graphSnapshot does not ORDER BY its entities', () => {
    const { nodes, edges } = twoCliques();
    const forward = clusterGraph(nodes, edges);
    const backward = clusterGraph([...nodes].reverse(), edges);

    // Ids may differ; the PARTITION must not.
    const partition = ({ assignment }) => {
      const groups = new Map();
      for (const [id, c] of assignment) {
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(id);
      }
      return [...groups.values()].map((g) => g.sort().join(',')).sort();
    };
    expect(partition(backward)).toEqual(partition(forward));
  });

  it('anchors the largest cluster at the origin and parks the unconnected outermost', () => {
    const { nodes, edges } = twoCliques();
    const lonely = ['x1', 'x2'].map((id) => entity(id, id));
    const extra = [entity('a5', 'a5'), entity('a6', 'a6')];
    const bigger = [...edges, link('a1', 'a5'), link('a2', 'a5'), link('a1', 'a6'), link('a2', 'a6')];
    const { clusters } = clusterGraph([...nodes, ...extra, ...lonely], bigger);

    const connected = clusters.filter((c) => !c.unconnected);
    const dist = (c) => Math.hypot(c.x, c.y);
    expect(dist(connected[0])).toBe(0);
    expect(connected[0].size).toBeGreaterThanOrEqual(connected[1].size);

    const bucket = clusters.find((c) => c.unconnected);
    expect(dist(bucket)).toBeGreaterThan(Math.max(...connected.map(dist)));
  });

  it('every cluster gets a distinct anchor', () => {
    const { nodes, edges } = twoCliques();
    const { clusters } = clusterGraph(nodes, edges);
    const seen = new Set(clusters.map((c) => `${c.x},${c.y}`));
    expect(seen.size).toBe(clusters.length);
  });

  it('colours every region from the generated ramp — grey means few links', () => {
    const nodes = [];
    const edges = [];
    for (let r = 0; r < 6; r++) {
      for (let i = 0; i < 6; i++) nodes.push(entity(`r${r}n${i}`, `r${r}n${i}`));
      for (let i = 0; i < 6; i++) {
        for (let j = i + 1; j < 6; j++) edges.push(link(`r${r}n${i}`, `r${r}n${j}`));
      }
      if (r) edges.push(link(`r${r}n0`, `r${r - 1}n0`));
    }
    const { clusters } = clusterGraph(nodes, edges, { minMajorSize: 4 });

    const regions = clusters.filter((c) => !c.minor && !c.unconnected);
    // The ramp sizes itself to the region count — no fixed palette to run out of.
    expect(regions.map((c) => c.color)).toEqual(regionShades(regions.length));
    for (const parked of clusters.filter((c) => c.minor || c.unconnected)) {
      expect(parked.color).toBeNull();
    }
  });

  it('generates distinct colours, stable per rank rather than per count', () => {
    const ramp = regionShades(11);
    expect(new Set(ramp).size).toBe(11);
    // A region keeps its colour as the graph grows — adding an 11th region must
    // not repaint the other ten.
    expect(regionShades(3)).toEqual(ramp.slice(0, 3));
    expect(regionShades(1)).toHaveLength(1);
    expect(regionShades(0)).toEqual([]);
  });

  it('never hands a region the grey reserved for "few links"', () => {
    // schemeSet3 ships a grey (#d9d9d9). Grey is load-bearing in this view, so
    // a region must never be painted in it.
    for (const c of regionShades(12)) expect(c).not.toBe('#d9d9d9');
  });

  it('clears the 3:1 contrast floor against the near-black canvas', () => {
    const lum = (hex) => [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((a, c, i) => a + [0.2126, 0.7152, 0.0722][i] * c, 0);
    const surface = lum('#0b0c0e');

    for (const c of regionShades(12)) {
      expect((lum(c) + 0.05) / (surface + 0.05)).toBeGreaterThanOrEqual(3);
    }
  });

  it('folds small communities into one parked group instead of scattering them', () => {
    // One substantial community plus a spray of 2-node fragments — exactly the
    // shape that flung 40 fragments across the viewport.
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 12; i++) nodes.push(entity(`big${i}`, `big${i}`));
    for (let i = 0; i < 12; i++) {
      for (let j = i + 1; j < 12; j++) edges.push(link(`big${i}`, `big${j}`));
    }
    for (let f = 0; f < 8; f++) {
      nodes.push(entity(`p${f}a`, `p${f}a`), entity(`p${f}b`, `p${f}b`));
      edges.push(link(`p${f}a`, `p${f}b`));
    }
    const { assignment, clusters } = clusterGraph(nodes, edges, { minMajorSize: 5 });

    for (let f = 0; f < 8; f++) expect(assignment.get(`p${f}a`)).toBe(MINOR);
    const minor = clusters.find((c) => c.id === MINOR);
    expect(minor.size).toBe(16);
    expect(minor.color).toBeNull();
    // 1 real region + 1 parked group, not 9 anchors.
    expect(clusters).toHaveLength(2);
  });

  it('keeps the parked groups out of the centre', () => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 12; i++) nodes.push(entity(`big${i}`, `big${i}`));
    for (let i = 0; i < 12; i++) {
      for (let j = i + 1; j < 12; j++) edges.push(link(`big${i}`, `big${j}`));
    }
    for (let f = 0; f < 6; f++) {
      nodes.push(entity(`p${f}a`, `p${f}a`), entity(`p${f}b`, `p${f}b`));
      edges.push(link(`p${f}a`, `p${f}b`));
    }
    nodes.push(entity('lonely', 'lonely'));
    const { clusters } = clusterGraph(nodes, edges, { minMajorSize: 5 });

    const dist = (c) => Math.hypot(c.x, c.y);
    const real = clusters.filter((c) => !c.minor && !c.unconnected);
    for (const parked of clusters.filter((c) => c.minor || c.unconnected)) {
      expect(dist(parked)).toBeGreaterThan(Math.max(...real.map(dist)));
    }
  });

  it('names a cluster after its highest-degree entity, ignoring facts', () => {
    const nodes = [
      entity('e1', 'hub'), entity('e2', 'spoke'),
      { id: 'f1', kind: 'fact', label: 'a fact that mentions everything' },
    ];
    const edges = [link('e1', 'e2'), link('f1', 'e1'), link('f1', 'e2')];
    // minMajorSize:1 — a 3-node graph is otherwise all "minor", which is right
    // in the app and beside the point here.
    const { clusters } = clusterGraph(nodes, edges, { minMajorSize: 1 });

    expect(clusters[0].label).toBe('hub');
  });

  it('assigns every node exactly once, including on an edgeless graph', () => {
    const nodes = ['n1', 'n2'].map((id) => entity(id, id));
    const { assignment, clusters } = clusterGraph(nodes, []);

    expect(assignment.size).toBe(2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].unconnected).toBe(true);
  });

  it('tolerates edges naming nodes that are not in the node set', () => {
    const { nodes, edges } = twoCliques();
    const { assignment } = clusterGraph(nodes, [...edges, link('a1', 'ghost')]);
    expect(assignment.size).toBe(nodes.length);
  });

  it('resolves edges whose endpoints force-graph has already hydrated to objects', () => {
    const { nodes, edges } = twoCliques();
    const hydrated = edges.map((e) => ({ source: { id: e.source }, target: { id: e.target } }));
    const { assignment } = clusterGraph(nodes, hydrated);
    expect(assignment.get('a1')).not.toBe(assignment.get('b1'));
  });
});
