/**
 * Graph view — a React island around react-force-graph-2d.
 *
 * The rest of the dashboard is vanilla ES modules with no build step, so this
 * is deliberately the ONLY React in the app: it mounts into one container, owns
 * only presentation, and exposes an imperative handle so app.js keeps driving
 * data-loading and routing exactly as before. Nothing else needs to know React
 * is here.
 *
 * Colours are read from the CSS custom properties at mount rather than
 * hardcoded. The previous canvas renderer duplicated --etype-* as literal hex
 * in JS, so the graph and the legend beside it could drift apart the moment a
 * token changed. Now DESIGN.md's token file is the single source of truth for
 * both.
 *
 * Bundled by `npm run build:gui` into ../vendor/graph-island.js.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ForceGraph2D from 'react-force-graph-2d';
// d3-force-3d is the exact force library force-graph runs internally, so these
// compose with its simulation rather than fighting it. forceX/forceY are how
// d3 does gravity — forceCenter only translates the centroid, it does not pull
// anything inward, which is why the graph drifted apart without them.
import { forceX, forceY, forceCollide } from 'd3-force-3d';
import { clusterGraph } from './cluster.js';

/** Design tokens, read live so the graph can never drift from the stylesheet. */
function readTokens() {
  const s = getComputedStyle(document.documentElement);
  const t = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    person: t('--etype-person', '#9bd6ff'),
    topic: t('--etype-topic', '#2f81f7'),
    document: t('--etype-document', '#36cfa6'),
    fact: t('--etype-fact', '#565a63'),
    brand: t('--brand', '#0084ff'),
    fg1: t('--fg-1', '#f4f5f6'),
    fg3: t('--fg-3', '#82858c'),
    fg4: t('--fg-4', '#50535a'),
    bg: t('--bg-1', '#0b0c0e'),
    fontSans: t('--font-sans', "'Geist', ui-sans-serif, system-ui, sans-serif"),
  };
}

const prefersReducedMotion = () =>
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** `#rrggbb` → `rgba(r,g,b,a)`, so link alpha can come off a design token. */
function alpha(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  if (!m) return `rgba(130,133,140,${a})`;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Deterministic 32-bit string hash. Used only to scatter a cluster's nodes
 * around their anchor — Math.random() would make the layout differ run to run,
 * which is the thing cluster.js goes out of its way to avoid.
 */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Entities scale gently with connectivity; facts stay small dots. */
function nodeRadius(n) {
  if (n.kind !== 'entity') return 2.4;
  const deg = n.degree || 0;
  return Math.max(3.5, Math.min(3 + Math.sqrt(deg + (n.mentions || 0)) * 1.5, 11));
}

function GraphView({ api }) {
  const fgRef = useRef(null);
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [graph, setGraph] = useState({ nodes: [], links: [] });
  const [hover, setHover] = useState(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const tokens = useMemo(readTokens, []);
  const fitted = useRef(false);
  const labelRects = useRef([]);   // per-frame label occlusion buffer
  // force-graph mutates the very node objects handed to the graphData PROP,
  // adding x/y/vx/vy in place — so holding them here is how we reach live
  // positions. The ref exposes no graphData() getter (see relayout).
  const nodesRef = useRef([]);

  // Adjacency for hover highlight, rebuilt whenever data changes. Built from
  // the ORIGINAL ids: force-graph mutates each link's source/target from an id
  // string into a node reference once the simulation starts.
  const adjacency = useMemo(() => {
    const m = new Map();
    for (const n of graph.nodes) m.set(n.id, new Set());
    for (const l of graph.links) {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (m.has(s) && m.has(t)) { m.get(s).add(t); m.get(t).add(s); }
    }
    return m;
  }, [graph]);

  // Only label the biggest hubs on a dense graph; zooming past 1.45 reveals the
  // rest. Without this the centre of a real store is unreadable overlap.
  const hubMin = graph.nodes.length > 150 ? 10 : 2;

  useEffect(() => {
    api.current = {
      setData: (data) => {
        fitted.current = false;
        // Communities first: every node carries its cluster's anchor, which is
        // what the gravity forces below pull toward instead of a shared origin.
        const { assignment, clusters } = clusterGraph(data.nodes, data.edges);
        const anchors = new Map(clusters.map((c) => [c.id, c]));
        const seeded = {
          // Sorted by connectivity, descending. force-graph paints in array
          // order, and the label occlusion buffer is first-come-first-served —
          // so drawing hubs first is what makes the important labels win the
          // space instead of whichever node happened to be earlier in the JSON.
          nodes: data.nodes
            .map((n) => {
              const anchor = anchors.get(assignment.get(n.id));
              return {
                ...n,
                r: nodeRadius(n),
                cluster: assignment.get(n.id),
                clusterColor: anchor?.color ?? null,
                // Seed the position at the anchor too, not just the target: a
                // node that STARTS in its cluster settles there, instead of
                // migrating across the canvas from a random origin and dragging
                // its neighbours through every other cluster on the way.
                cx: anchor?.x ?? 0,
                cy: anchor?.y ?? 0,
                x: (anchor?.x ?? 0) + (hash(n.id) % 40) - 20,
                y: (anchor?.y ?? 0) + (hash(`${n.id}#`) % 40) - 20,
              };
            })
            .sort((a, b) => (b.degree || 0) - (a.degree || 0)),
          links: data.edges.map((e) => ({ ...e })),
        };
        nodesRef.current = seeded.nodes;
        api.current?.onClusters?.(clusters);
        setGraph(seeded);
      },
      zoomBy: (f) => fgRef.current?.zoom(fgRef.current.zoom() * f, 200),
      fit: () => fgRef.current?.zoomToFit(400, 64),
      // Reheating alone looked like a no-op: alpha went back to 1 but every
      // node was already at its solution, so the forces just re-converged on the
      // same picture. Re-seed positions first — unpin, scatter onto a ring sized
      // to the node count, zero velocity — so the run genuinely explores a new
      // layout, then re-fit when it settles.
      refit: () => { setHover(null); fgRef.current?.zoomToFit(400, 64); },
    };
  }, [api]);

  // Keep the canvas matched to its container — the old renderer's 0×0 races
  // came from letting the library guess.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Degree per node id — drives both link distance and link strength below.
  const degrees = useMemo(() => {
    const d = new Map();
    for (const l of graph.links) {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      d.set(s, (d.get(s) || 0) + 1);
      d.set(t, (d.get(t) || 0) + 1);
    }
    return d;
  }, [graph]);

  // Force tuning. The previous flat `link.strength(0.28)` was the main reason a
  // real store collapsed into a hairball: it pulls EVERY edge equally hard, so
  // a hub with 20 edges gets 20 units of inward pull and drags its whole
  // neighbourhood into a knot. d3's own default is 1/min(deg), which is the
  // standard anti-hairball heuristic — a well-connected node holds each
  // individual neighbour loosely. Link distance also grows with degree so hubs
  // get the room their labels need, and a longer distanceMax lets separate
  // clusters actually push each other apart instead of stacking.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    const n = graph.nodes.length;
    const deg = (node) => degrees.get(node.id ?? node) || 1;

    fg.d3Force('charge')
      .strength(n > 400 ? -40 : n > 150 ? -75 : -110)
      .distanceMax(n > 400 ? 300 : 420);
    fg.d3Force('link')
      .distance((l) => 26 + Math.min(deg(l.source) + deg(l.target), 40) * 1.6)
      .strength((l) => 1 / Math.max(1, Math.min(deg(l.source), deg(l.target))));

    // Gravity. forceCenter (force-graph's default 'center') only re-centres the
    // centroid — it exerts no inward pull, so with repulsion raised to break the
    // hairball the components simply drifted apart and orphans flew to the
    // margins. forceX/forceY toward the origin is d3's actual gravity: it pulls
    // everything toward one mass without collapsing structure, because the
    // charge/link forces still set local spacing. Scaled down as the graph grows
    // so a big store doesn't get crushed into the middle.
    // Toward each node's CLUSTER anchor, not a single shared origin. Same
    // mechanism and same strengths as before — only the target moved. This is
    // what stops 78 components from stacking on one point.
    const g = n > 400 ? 0.045 : n > 150 ? 0.07 : 0.09;
    fg.d3Force('x', forceX((nd) => nd.cx ?? 0).strength(g));
    fg.d3Force('y', forceY((nd) => nd.cy ?? 0).strength(g));

    // d3's quadtree collide — O(n log n) against the previous hand-rolled
    // O(n²) pass, and it is the implementation force-graph's own simulation
    // expects. Radius leaves room for the label under each node.
    fg.d3Force('collide', forceCollide().radius((nd) => nd.r + 10).strength(0.85));
  }, [graph, degrees]);

  const paintNode = useCallback((n, ctx, scale) => {
    const lit = hover ? adjacency.get(hover.id) : null;
    const on = !hover || n.id === hover.id || lit?.has(n.id);
    ctx.globalAlpha = on ? 1 : 0.18;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    if (n.kind === 'entity') {
      // Colour carries CLUSTER, not entity type. On a real store the type
      // channel was near-constant — 301 topics against 1 person and 4
      // documents — so it spent the whole colour budget saying nothing.
      // Cluster membership is the thing you actually need to see. Type still
      // reads in the tooltip and the KB list, where it isn't competing with
      // 500 dots. Clusters past the palette stay neutral by design.
      ctx.fillStyle = n.clusterColor || tokens.fg4;
      ctx.fill();
      if (n.id === hover?.id) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = tokens.fg1; ctx.stroke(); }
    } else if (n.kind === 'document') {
      ctx.fillStyle = tokens.document;
      ctx.fill();
      if (n.id === hover?.id) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = tokens.fg1; ctx.stroke(); }
    } else {
      ctx.fillStyle = tokens.fact;
      ctx.fill();
      if (n.id === hover?.id) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = tokens.brand; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;

    const isHub = n.kind === 'entity' && (n.degree || 0) >= hubMin;
    const wantLabel = n.id === hover?.id || (n.kind === 'entity' && on && (isHub || scale > 1.45));
    if (!wantLabel) return;

    const label = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
    const size = 11 / scale;
    ctx.font = `${n.kind === 'entity' ? 600 : 400} ${size}px ${tokens.fontSans}`;
    const w = ctx.measureText(label).width;
    const x = n.x - w / 2;
    const y = n.y + n.r + 2 / scale;

    // Occlusion culling. Nodes are painted hub-first, so a label only draws if
    // it doesn't collide with one already placed this frame — which is what
    // turns a dense cluster from overlapping mush into a readable subset. The
    // hovered node always wins; you can still read anything by pointing at it,
    // and zooming in frees space so the rest reappear.
    const pad = 2 / scale;
    const rect = { x1: x - pad, y1: y - pad, x2: x + w + pad, y2: y + size + pad };
    const hovered = n.id === hover?.id;
    if (!hovered) {
      for (const r of labelRects.current) {
        if (rect.x1 < r.x2 && rect.x2 > r.x1 && rect.y1 < r.y2 && rect.y2 > r.y1) return;
      }
    }
    labelRects.current.push(rect);

    // Halo so a label crossing a link stays legible without a solid backing box.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = tokens.bg;
    ctx.lineJoin = 'round';
    ctx.strokeText(label, n.x, y);
    ctx.fillStyle = on ? tokens.fg1 : tokens.fg3;
    ctx.fillText(label, n.x, y);
  }, [hover, adjacency, hubMin, tokens]);

  // Generous, radius-aware hit target — small fact dots are otherwise
  // effectively unclickable.
  const paintPointerArea = useCallback((n, color, ctx) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, Math.max(n.r, 6), 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  // Three tiers: incident-to-hover, idle, and faded-while-hovering-elsewhere,
  // so the focused subgraph reads clearly without hiding the rest.
  // Links are grey, off --fg-4, in every state — colour on an edge competes
  // with colour on a node, and the nodes are what carry meaning here. The
  // mention/relation distinction moves to opacity and width instead, so the
  // three hover tiers (incident / idle / faded) still read.
  const linkColor = useCallback((l) => {
    const sid = l.source?.id ?? l.source;
    const tid = l.target?.id ?? l.target;
    const incident = hover && (sid === hover.id || tid === hover.id);
    const faded = hover && !incident;
    const strong = l.kind === 'relation';
    if (incident) return alpha(tokens.fg3, strong ? 0.95 : 0.75);
    if (faded) return alpha(tokens.fg4, 0.06);
    return alpha(tokens.fg4, strong ? 0.55 : 0.32);
  }, [hover, tokens]);

  const reduced = prefersReducedMotion();

  return (
    <div
      ref={wrapRef}
      className="graph-react-wrap"
      onPointerMove={(e) => {
        const r = wrapRef.current.getBoundingClientRect();
        setPointer({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
      onPointerLeave={() => setHover(null)}
    >
      {size.width > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={graph}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointerArea}
          linkColor={linkColor}
          linkWidth={(l) => (l.kind === 'relation' ? 1.3 : 1)}
          onRenderFramePre={() => { labelRects.current.length = 0; }}
          onNodeHover={setHover}
          onNodeClick={(n) => api.current?.onNodeClick?.(n)}
          // Release the node instead of pinning it. Setting fx/fy on drop froze
          // whatever you dragged, so gravity could never reclaim it and its
          // neighbours stretched away from the mass trying to follow — which is
          // exactly the "dragged clusters flow away" behaviour. Dropping it back
          // into the simulation lets the layout re-absorb it.
          onNodeDragEnd={(n) => { n.fx = undefined; n.fy = undefined; }}
          onBackgroundClick={() => setHover(null)}
          warmupTicks={reduced ? 200 : 0}
          cooldownTicks={reduced ? 0 : 200}
          onEngineStop={() => {
            if (fitted.current) return;
            fitted.current = true;
            fgRef.current?.zoomToFit(0, 55);
            if (fgRef.current && fgRef.current.zoom() > 1.5) fgRef.current.zoom(1.5, 0);
          }}
        />
      )}
      {hover && <Tooltip node={hover} pointer={pointer} wrap={wrapRef.current} />}
    </div>
  );
}

function Tooltip({ node, pointer, wrap }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !wrap) return;
    const w = el.offsetWidth || 220;
    const h = el.offsetHeight || 64;
    setPos({
      left: Math.max(4, Math.min(pointer.x + 14, wrap.clientWidth - w - 4)),
      top: Math.max(4, Math.min(pointer.y + 14, wrap.clientHeight - h - 4)),
    });
  }, [pointer, wrap, node]);

  const kind = node.kind === 'entity'
    ? String(node.entityType || 'topic').replace(/_/g, ' ')
    : 'Fact';
  return (
    <div ref={ref} className="graph-tooltip" style={{ left: pos.left, top: pos.top }}>
      <span className="gt-kind">{kind}</span>
      {node.label}
      {node.kind === 'entity' && (
        <span className="gt-meta">{node.mentions} mentions · {node.degree} links</span>
      )}
    </div>
  );
}

/**
 * Mount the island. Returns the imperative handle app.js drives; `onNodeClick`
 * is assigned onto it by the caller so routing stays outside React.
 */
export function mountGraph(container) {
  let impl = null;      // the component's methods, registered on mount
  let pending = null;   // data that arrived before React committed

  const handle = {
    // createRoot().render() is asynchronous, so the caller's first setData()
    // lands BEFORE the component exists. Optional-chaining it away silently
    // drops the initial graph and leaves a correctly-sized, permanently blank
    // canvas — buffer instead and flush on mount.
    setData: (d) => { if (impl) impl.setData(d); else pending = d; },
    zoomBy: (f) => impl?.zoomBy(f),
    fit: () => impl?.fit(),
    refit: () => impl?.refit(),
    onNodeClick: null,
    onClusters: null,
  };

  // The component assigns its methods to `api.current`; this setter is where
  // the buffered data gets flushed and the click handler is bridged back out.
  const api = {
    get current() { return impl; },
    set current(v) {
      impl = v;
      if (!impl) return;
      impl.onNodeClick = (n) => handle.onNodeClick?.(n);
      impl.onClusters = (c) => handle.onClusters?.(c);
      if (pending) { impl.setData(pending); pending = null; }
    },
  };

  const root = createRoot(container);
  root.render(<GraphView api={api} />);
  handle.destroy = () => root.unmount();
  return handle;
}
