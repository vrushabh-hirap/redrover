/**
 * RedRover — Solar System Explorer and AI Mission Planner.
 *
 * Three clearly separated modes:
 *   Explorer — navigate the whole Solar System, inspect bodies and objects
 *   Mission  — pick an origin on Earth, a destination, an algorithm and a cost
 *              model, then run a *conceptual AI graph route*
 *   Traffic  — a time-evolving Earth-orbit simulation with D* Lite replanning
 *
 * Data provenance is surfaced in the top bar badge and the Data panel. Nothing
 * synthetic is ever shown with a real-data badge.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { HorizonsEphemeris } from './data/horizons';
import { CatalogObject } from './data/types';
import {
  CATALOG_GROUPS,
  CATALOG_MIX_DEFS,
  CatalogStatus,
  DEFAULT_GROUP,
  fetchLiveCatalog,
  loadBundledCatalog,
  newestElementEpoch,
  parseUserElements,
} from './data/celestrak';
import { Sgp4Client } from './data/sgp4Client';
import { Sgp4Propagator } from './orbit/sgp4';
import { SolarScene, SceneLabel } from './scene/SolarScene';
import { BODY_INFO, EMPTY_FILTER, SatelliteFilter } from './scene/scale';
import { regionOf } from './data/types';

import {
  ALGORITHMS,
  ALGORITHM_ORDER,
  AlgorithmId,
  PlanResult,
  runAllStatic,
  runPlan,
} from './planners/staticPlanners';
import {
  COST_MODELS,
  CostModelId,
  KEEP_OUT_CHOICES,
  MissionGraph,
  MissionNode,
  costModel,
  sitePositionKm,
  DEFAULT_GRAPH_OPTIONS,
} from './core/missionGraph';
import { DStarLite, DStarSnapshot, OrbitGridSpec, cellCentre } from './planners/dStarLite';

import { TopBar, BodyHit, SEARCHABLE_BODIES } from './ui/TopBar';
import { LeftPanel, OriginState, DestinationState } from './ui/LeftPanel';
import { Inspector, BodyInspectorData, SatInspectorData } from './ui/Inspector';
import { DataPanel, SourceBlock } from './ui/DataPanel';
import { TimeBar } from './ui/TimeBar';
import { Stat, Tag, fmt, fmtDuration, utc, utcShort } from './ui/common';

const LAUNCH_SITES = [
  { name: 'Cape Canaveral (KSC)', lat: 28.5729, lon: -80.649 },
  { name: 'Baikonur Cosmodrome', lat: 45.965, lon: 63.305 },
  { name: 'Guiana Space Centre', lat: 5.236, lon: -52.775 },
  { name: 'Satish Dhawan (SHAR)', lat: 13.72, lon: 80.23 },
  { name: 'Vandenberg SFB', lat: 34.742, lon: -120.572 },
  { name: 'Jiuquan (JSLC)', lat: 40.96, lon: 100.298 },
  { name: 'Tanegashima', lat: 30.4, lon: 130.97 },
  { name: 'Rocket Lab LC-1', lat: -39.262, lon: 177.865 },
];

const DSTAR_GRID: OrbitGridSpec = {
  altBands: 9,
  azSectors: 20,
  polarSectors: 7,
  timeSteps: 20,
  stepSec: 300,
  keepOutKm: 90,
};
const DSTAR_SEED = 20261015;
const DSTAR_START_CELL: [number, number, number] = [1, 4, 3];
const DSTAR_GOAL_CELL: [number, number, number] = [7, 14, 3];
const DSTAR_OBJECT_CAP = 400;

export const App: React.FC = () => {
  // ── mode & time ────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'explorer' | 'mission' | 'traffic'>('explorer');
  const [simDate, setSimDate] = useState<Date>(() => new Date());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3_600);

  // ── data ───────────────────────────────────────────────────────────────
  const horizonsRef = useRef<HorizonsEphemeris>(new HorizonsEphemeris());
  const [horizonsReady, setHorizonsReady] = useState(false);
  const sgp4Ref = useRef<Sgp4Client>(new Sgp4Client());
  const [catalog, setCatalog] = useState<CatalogObject[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogGroup, setCatalogGroup] = useState(DEFAULT_GROUP);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // ── scene ──────────────────────────────────────────────────────────────
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SolarScene | null>(null);
  const [labels, setLabels] = useState<SceneLabel[]>([]);
  const [selectedBody, setSelectedBody] = useState<string | null>(null);
  const [selectedSat, setSelectedSat] = useState<CatalogObject | null>(null);
  const [scaleInfo, setScaleInfo] = useState({ mode: 'overview' as 'overview' | 'focus', focus: null as string | null });
  const [clickMode, setClickMode] = useState<'inspect' | 'set_origin' | 'set_destination'>('inspect');
  const [panelOpen, setPanelOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<'explore' | 'mission' | 'catalog' | 'layers'>('explore');
  const [dataPanelOpen, setDataPanelOpen] = useState(false);

  // ── mission ────────────────────────────────────────────────────────────
  const [origin, setOrigin] = useState<OriginState | null>(null);
  const [destination, setDestination] = useState<DestinationState | null>(null);
  const [algorithm, setAlgorithm] = useState<AlgorithmId>('astar');
  const [costModelId, setCostModelId] = useState<CostModelId>('balanced');
  const [keepOutKm, setKeepOutKm] = useState<number>(DEFAULT_GRAPH_OPTIONS.keepOutKm);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [compare, setCompare] = useState<PlanResult[] | null>(null);
  const [planning, setPlanning] = useState(false);

  // ── catalog UI ─────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<SatelliteFilter>({
    ...EMPTY_FILTER,
    regions: new Set(['LEO', 'MEO', 'GEO', 'HEO', 'other']),
  });

  // ── layers ─────────────────────────────────────────────────────────────
  const [layers, setLayers] = useState({
    orbits: true,
    labels: true,
    satellites: true,
    route: true,
    hazards: false,
  });

  // ── traffic / D* ───────────────────────────────────────────────────────
  const [trafficRunning, setTrafficRunning] = useState(false);
  const [trafficSpeed, setTrafficSpeed] = useState(1);
  const [dstarEvents, setDstarEvents] = useState<
    { type: string; message: string; timeSec: number; changedEdges?: number; expandedInRepair?: number; pathCost?: number }[]
  >([]);
  const [dstarReport, setDstarReport] = useState<{
    replans: number; changedEdges: number; expandedInRepair: number; pathCost: number; pathLength: number; wallMs: number;
  } | null>(null);
  // The initial snapshot is the deterministic replay point.
  const [dstarInitialSnapshot, setDstarInitialSnapshot] = useState<DStarSnapshot | null>(null);
  const dstarRef = useRef<DStarLite | null>(null);
  const dstarPropRef = useRef<Sgp4Propagator | null>(null);
  const trafficTimer = useRef<number | null>(null);
  const catalogStatesRef = useRef<Map<number, { x: number; y: number; z: number }>>(new Map());

  const [query, setQuery] = useState('');
  const simDateRef = useRef<Date>(simDate);
  simDateRef.current = simDate;
  const [sceneCounts, setSceneCounts] = useState({ loaded: 0, matching: 0, rendered: false });

  // ── data loading ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    horizonsRef.current.loadBundled().then((ok) => {
      if (alive) setHorizonsReady(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const applyCatalog = useCallback((objects: CatalogObject[], status: CatalogStatus) => {
    setCatalog(objects);
    setCatalogStatus(status);
    sgp4Ref.current.load(objects);
    sceneRef.current?.setCatalog(objects, simDate);
  }, [simDate]);

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true);
    setCatalogError(null);
    loadBundledCatalog(catalogGroup)
      .then((res) => {
        if (!alive) return;
        applyCatalog(res.objects, res.status);
        setCatalogLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setCatalogError(String(err));
        setCatalogLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogGroup]);

  const refreshLive = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const res = await fetchLiveCatalog(catalogGroup);
      applyCatalog(res.objects, res.status);
    } catch (err) {
      setCatalogError(String(err));
    } finally {
      setCatalogLoading(false);
    }
  }, [catalogGroup, applyCatalog]);

  // ── scene construction ─────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !horizonsReady) return;
    const scene = new SolarScene(host, document.createElement('div'), horizonsRef.current, simDate);
    sceneRef.current = scene;
    scene.onLabels = setLabels;
    scene.onSelectBody = (name) => {
      setSelectedBody(name);
      setSelectedSat(null);
    };
    scene.onSelectSatellite = (obj) => {
      setSelectedSat(obj);
      setSelectedBody(null);
    };
    scene.onPickOrigin = (lat, lon, label) => {
      setOrigin({ name: label, lat, lon, source: 'surface-click' });
      setClickMode('inspect');
      scene.setClickMode('inspect');
      setLeftTab('mission');
    };
    scene.onPickDestination = (name, kind, _posKm) => {
      setDestinationFromScene(name, kind, _posKm);
      setClickMode('inspect');
      scene.setClickMode('inspect');
      setLeftTab('mission');
    };
    scene.onCameraChange = ({ scaleMode, focusBody }) => setScaleInfo({ mode: scaleMode, focus: focusBody });
    if (catalog.length > 0) scene.setCatalog(catalog, simDate);
    // Test/automation hook: lets browser checks read real scene state without
    // reaching into React internals.
    (window as unknown as { __redrover?: unknown }).__redrover = {
      getScale: () => scene.currentScale,
      getCamera: () => ({
        distance: scene.cameraDistance,
        goalDistance: scene.debugCamGoal(),
        target: [scene.camTarget.x, scene.camTarget.y, scene.camTarget.z],
        position: [scene.camera.position.x, scene.camera.position.y, scene.camera.position.z],
      }),
      getCounts: () => scene.counts,
      getBodyScreenPositions: () => scene.debugLabelPositions(),
      getLabels: () => scene.debugLabels(),
      getSatPositions: (n?: number) => scene.debugSatellitePositions(n),
      flyTo: (name: string) => scene.flyToBody(name),
      frameOrbits: () => scene.frameOrbitalRegion(),
      frameSystem: (name: string) => scene.frameSystem(name),
      overview: () => scene.resetCamera(),
      step: (n = 1) => scene.step(n),
      capture: () => scene.capture(),
      /** Canvas capture plus the HTML label overlay drawn on top, for evidence. */
      captureComposite: () =>
        new Promise<string>((resolve) => {
          const png = scene.capture();
              const labels = scene.debugLabels();
              const img = new Image();
              img.onload = () => {
                const cv = document.createElement('canvas');
                cv.width = img.width;
                cv.height = img.height;
                const ctx = cv.getContext('2d')!;
                ctx.drawImage(img, 0, 0);
                const dpr = img.width / Math.max(1, window.innerWidth);
                for (const l of labels) {
                  const x = l.screenX * dpr;
                  const y = l.screenY * dpr;
                  const fs = (l.kind === 'moon' ? 9 : 10) * dpr;
                  ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
                  const w = ctx.measureText(l.name).width + 14 * dpr;
                  const h = fs + 8 * dpr;
                  ctx.fillStyle = l.selected ? 'rgba(8,26,44,0.88)' : 'rgba(4,8,18,0.72)';
                  ctx.strokeStyle = l.selected ? 'rgba(88,199,243,0.6)' : 'rgba(148,178,224,0.2)';
                  ctx.lineWidth = 1 * dpr;
                  ctx.beginPath();
                  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
                  ctx.fill();
                  ctx.stroke();
                  ctx.fillStyle = l.selected ? '#58c7f3' : '#9aa8c4';
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  ctx.fillText(l.name, x, y);
                }
          resolve(cv.toDataURL('image/png'));
          };
          img.src = png;
        }),
    };
    return () => {
      delete (window as unknown as { __redrover?: unknown }).__redrover;
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizonsReady]);

  useEffect(() => {
    sceneRef.current?.setClickMode(clickMode);
  }, [clickMode]);

  // Push the catalog into the scene whenever either side becomes available.
  useEffect(() => {
    if (catalog.length > 0) sceneRef.current?.setCatalog(catalog, simDate);
  }, [catalog, horizonsReady, simDate]);

  useEffect(() => {
    sceneRef.current?.setSimDate(simDate);
  }, [simDate]);

  useEffect(() => {
    sceneRef.current?.setFilter(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, catalog]);

  // ── time animation ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setSimDate((prev) => new Date(prev.getTime() + speed * 250));
    }, 250);
    return () => clearInterval(id);
  }, [playing, speed]);

  // ── helpers ────────────────────────────────────────────────────────────
  const ephem = useMemo(() => horizonsRef.current.statesAt(simDate) ?? {}, [simDate, horizonsReady]);

  const setDestinationFromScene = useCallback(
    (name: string, kind: 'body' | 'satellite', posKm: THREE.Vector3) => {
      if (kind === 'body') {
        const info = BODY_INFO[name];
        setDestination({
          id: `body:${name}`,
          name,
          kind: info?.kind === 'moon' ? 'moon' : 'planet',
          subtitle: info?.kind === 'moon' ? `Moon of ${info.parent}` : 'Planet',
          distanceKm: ephem[name] ? Math.hypot(
            ephem[name].position.x - (ephem.Earth?.position.x ?? 0),
            ephem[name].position.y - (ephem.Earth?.position.y ?? 0),
            ephem[name].position.z - (ephem.Earth?.position.z ?? 0),
          ) : undefined,
        });
        return;
      }
      setDestination({
        id: `sat:${name}`,
        name,
        kind: 'satellite',
        subtitle: 'Cataloged Earth-orbit object',
      });
    },
    [ephem],
  );

  const focusBody = useCallback((name: string) => {
    sceneRef.current?.flyToBody(name);
    setSelectedBody(name);
    setSelectedSat(null);
    setClickMode('inspect');
    sceneRef.current?.setClickMode('inspect');
  }, []);

  // ── search ─────────────────────────────────────────────────────────────
  const searchResults = useMemo<BodyHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];
    const bodies = SEARCHABLE_BODIES.filter((b) => b.name.toLowerCase().includes(q)).slice(0, 6);
    const sats = catalog
      .filter((o) => o.name.toLowerCase().includes(q) || String(o.noradId).includes(q))
      .slice(0, 6)
      .map((o) => ({ name: o.name, kind: 'satellite' as const, subtitle: `NORAD ${o.noradId} · ${o.type}` }));
    return [...bodies, ...sats] as BodyHit[];
  }, [query, catalog]);

  const onSearchResult = useCallback(
    (r: BodyHit) => {
      const sat = catalog.find((o) => o.name === r.name);
      if (sat) {
        setSelectedSat(sat);
        setSelectedBody(null);
        sceneRef.current?.flyToSatellite(sat);
        return;
      }
      focusBody(r.name);
    },
    [catalog, focusBody],
  );

  // ── mission graph ──────────────────────────────────────────────────────
  const originNode = useMemo<MissionNode | null>(() => {
    if (!origin) return null;
    const p = sitePositionKm(origin.lat, origin.lon);
    return {
      id: `site:${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}`,
      name: origin.name,
      kind: 'site',
      positionKm: { x: p.x, y: p.y, z: p.z },
    };
  }, [origin]);

  const destinationNode = useMemo<MissionNode | null>(() => {
    if (!destination) return null;
    if (destination.kind === 'satellite') {
      const sat = catalog.find((o) => o.name === destination.name);
      const alt = sat?.altitudeKm ?? 420;
      return {
        id: `sat:${destination.id}`,
        name: destination.name,
        kind: 'sat',
        noradId: sat?.noradId,
        altitudeKm: alt,
        positionKm: (() => {
          const st = catalogStatesRef.current.get(sat?.noradId ?? -1);
          if (st) return { x: st.x, y: st.y, z: st.z };
          return sitePositionKm(destination.kind === 'satellite' ? 0 : 0, 0, alt);
        })(),
      };
    }
    // Mission-graph nodes are Earth-centred: a body destination's position is
    // its heliocentric vector minus Earth's.
    const st = ephem[destination.name];
    const earth = ephem.Earth;
    const pos =
      st && earth
        ? { x: st.position.x - earth.position.x, y: st.position.y - earth.position.y, z: st.position.z - earth.position.z }
        : { x: 0, y: 0, z: 0 };
    return {
      id: `body:${destination.name}`,
      name: destination.name,
      kind: destination.kind === 'moon' ? 'moon' : 'body',
      positionKm: pos,
    };
  }, [destination, catalog, ephem]);

  const catalogStates = useMemo(() => {
    const p = new Sgp4Propagator(catalog);
    return p.propagateBatch(simDate);
  }, [catalog, simDate]);

  const hazardStates = useMemo(
    () =>
      catalogStates.map((s) => ({
        noradId: s.noradId,
        name: catalog.find((o) => o.noradId === s.noradId)?.name ?? `#${s.noradId}`,
        positionKm: s.position,
      })),
    [catalogStates, catalog],
  );

  const missionGraph = useMemo<MissionGraph | null>(() => {
    if (!originNode || !destinationNode) return null;
    return new MissionGraph({
      origin: originNode,
      destination: destinationNode,
      bodies: Object.fromEntries(Object.entries(ephem).map(([k, v]) => [k, v.position])),
      catalogStates: hazardStates,
      cost: costModel(costModelId),
      options: { keepOutKm },
    });
  }, [originNode, destinationNode, ephem, hazardStates, costModelId, keepOutKm]);

  const runPlanner = useCallback(
    (algo: AlgorithmId) => {
      if (!missionGraph || !originNode || !destinationNode) return;
      setPlanning(true);
      window.setTimeout(() => {
        try {
          const result = runPlan(missionGraph, algo, originNode, destinationNode);
          setPlan(result);
          setCompare(null);
          if (result.path.length >= 2) {
            sceneRef.current?.drawRoute(
              result.path.map((n) => new THREE.Vector3(n.positionKm.x, n.positionKm.y, n.positionKm.z)),
              result.explored.map((n) => new THREE.Vector3(n.positionKm.x, n.positionKm.y, n.positionKm.z)),
              'earth',
              missionGraph.hazards,
              keepOutKm,
            );
          } else {
            sceneRef.current?.clearRoute();
          }
        } finally {
          setPlanning(false);
        }
      }, 16);
    },
    [missionGraph, originNode, destinationNode],
  );

  const runCompare = useCallback(() => {
    if (!missionGraph || !originNode || !destinationNode) return;
    setPlanning(true);
    window.setTimeout(() => {
      try {
        const results = runAllStatic(missionGraph, originNode, destinationNode, ALGORITHM_ORDER);
        setCompare(results);
        setPlan(results.find((r) => r.algorithm === algorithm) ?? results[0]);
        const best = results.find((r) => r.path.length >= 2);
        if (best) {
          sceneRef.current?.drawRoute(
            best.path.map((n) => new THREE.Vector3(n.positionKm.x, n.positionKm.y, n.positionKm.z)),
            [],
            destinationNode.kind === 'sat' ? 'earth' : 'helio',
          );
        }
      } finally {
        setPlanning(false);
      }
    }, 16);
  }, [missionGraph, originNode, destinationNode, algorithm, keepOutKm]);

  // ── traffic / D* ───────────────────────────────────────────────────────
  const startDStar = useCallback(() => {
    const dstar = new DStarLite({
      grid: DSTAR_GRID,
      seed: DSTAR_SEED,
      manoeuvringCount: 4,
      manoeuvreProbability: 0.18,
    });
    const subset = catalog.slice(0, DSTAR_OBJECT_CAP);
    const prop = new Sgp4Propagator(subset);
    dstarPropRef.current = prop;
    for (let t = 0; t < DSTAR_GRID.timeSteps; t++) {
      const when = new Date(simDate.getTime() + t * DSTAR_GRID.stepSec * 1000);
      const states = prop.propagateBatch(when);
      dstar.setOccupancy(
        t,
        states.map((s) => ({ noradId: s.noradId, name: `#${s.noradId}`, positionKm: s.position })),
      );
    }
    dstar.epochMs = simDate.getTime();
    const path = dstar.plan(DSTAR_START_CELL, DSTAR_GOAL_CELL);
    dstarRef.current = dstar;
    setDstarEvents(dstar.events_.map((e) => ({ ...e })));
    setDstarReport({
      replans: 0,
      changedEdges: 0,
      expandedInRepair: 0,
      pathCost: dstar.pathCost(),
      pathLength: path.length,
      wallMs: 0,
    });
    setDstarInitialSnapshot(dstar.snapshot());
    void subset;
  }, [catalog, simDate]);

  /**
   * One traffic tick: objects advance, occupancy is re-propagated for the whole
   * horizon, and D* Lite repairs only the edges whose cost changed.
   */
  const trafficTick = useCallback(() => {
    const dstar = dstarRef.current;
    const prop = dstarPropRef.current;
    if (!dstar || !prop) return;
    const base = simDateRef.current.getTime();
    setSimDate(new Date(base + DSTAR_GRID.stepSec * 1000));
    const changed: string[] = [];
    for (let t = 0; t < DSTAR_GRID.timeSteps; t++) {
      const when = new Date(base + t * DSTAR_GRID.stepSec * 1000);
      const states = prop.propagateBatch(when);
      changed.push(
        ...dstar.setOccupancy(
          t,
          states.map((s) => ({ noradId: s.noradId, name: `#${s.noradId}`, positionKm: s.position })),
        ),
      );
    }
    dstar.drawManoeuvres(
      catalog.slice(0, DSTAR_OBJECT_CAP).map((o) => ({ noradId: o.noradId, name: o.name })),
    );
    const uniq = [...new Set(changed)];
    const report = dstar.advance(uniq);
    dstar.lastChanged = uniq;
    // Show the repaired route through the occupancy grid.
    const cells = dstar
      .path()
      .filter((id) => id !== 'GOAL')
      .map((id) => id.split(':').map(Number).slice(1) as [number, number, number]);
    sceneRef.current?.drawCellPath(cells);
    setDstarReport({ ...report });
    setDstarEvents(dstar.events_.slice(-60).map((e) => ({ ...e })));
  }, [catalog]);

  const stepDStar = useCallback(() => {
    if (!dstarRef.current) startDStar();
    window.setTimeout(trafficTick, 0);
  }, [startDStar, trafficTick]);

  const resetDStar = useCallback(() => {
    setDstarEvents([]);
    setDstarReport(null);
    dstarRef.current = null;
    dstarPropRef.current = null;
    sceneRef.current?.clearRoute();
  }, []);

  const stopTraffic = useCallback(() => {
    setTrafficRunning(false);
    if (trafficTimer.current) {
      window.clearInterval(trafficTimer.current);
      trafficTimer.current = null;
    }
  }, []);

  const startTraffic = useCallback(() => {
    if (!dstarRef.current) startDStar();
    else if (!dstarPropRef.current) {
      dstarPropRef.current = new Sgp4Propagator(catalog.slice(0, DSTAR_OBJECT_CAP));
    }
    setTrafficRunning(true);
  }, [catalog, startDStar]);

  useEffect(() => {
    if (!trafficRunning) return;
    const periodMs = Math.max(140, 1_600 / trafficSpeed);
    trafficTimer.current = window.setInterval(trafficTick, periodMs);
    return () => {
      if (trafficTimer.current) window.clearInterval(trafficTimer.current);
      trafficTimer.current = null;
    };
  }, [trafficRunning, trafficSpeed, trafficTick]);

  // ── catalog state sync for the scene counters ──────────────────────────
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = sceneRef.current?.counts;
      if (c) setSceneCounts({ ...c });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // ── origin / destination markers ───────────────────────────────────────
  useEffect(() => {
    if (!origin || !sceneRef.current) return;
    const scene = sceneRef.current;
    const lat = (origin.lat * Math.PI) / 180;
    const lon = (origin.lon * Math.PI) / 180;
    const r = 6378.137;
    const ecef = new THREE.Vector3(r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon));
    const gmst = 0; // approximate; markers are a UI affordance
    const c = Math.cos(gmst);
    const s = Math.sin(gmst);
    const eci = new THREE.Vector3(c * ecef.x - s * ecef.y, s * ecef.x + c * ecef.y, ecef.z);
    scene.markOrigin(eci);
  }, [origin, simDate]);

  useEffect(() => {
    if (!destination || !sceneRef.current) return;
    const scene = sceneRef.current;
    if (destination.kind === 'satellite') {
      const st = catalogStates.find((s) => s.noradId === catalog.find((o) => o.name === destination.name)?.noradId);
      if (st) scene.markDestination(new THREE.Vector3(st.position.x, st.position.y, st.position.z));
    } else {
      const p = ephem[destination.name];
      if (p) {
        // mark heliocentric position; the scene handles the frame
        scene.markDestination(new THREE.Vector3(p.position.x, p.position.y, p.position.z));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, simDate, catalogStates]);

  // ── derived UI data ────────────────────────────────────────────────────
  const horizonStatus = horizonsRef.current.status;
  const catalogKind = catalogStatus?.kind ?? 'unavailable';
  const staleDays =
    catalog.length > 0
      ? (simDate.getTime() - newestElementEpoch(catalog)) / 86_400_000
      : 0;
  const catalogStaleWarning =
    catalog.length === 0
      ? 'No Earth-orbit catalog is loaded, so the traffic view and mission graph have no occupancy model.'
      : Math.abs(staleDays) > 7
        ? `Requested epoch is ${Math.abs(staleDays) > 365 ? `${(Math.abs(staleDays) / 365.25).toFixed(1)} years` : `${Math.abs(staleDays).toFixed(1)} days`} ${staleDays > 0 ? 'after' : 'before'} the newest element epoch. SGP4 positions degrade beyond roughly ±7 days of an element epoch — treat them as indicative only.`
        : null;

  const coverageWarning = horizonsRef.current.outsideCoverage
    ? `The requested epoch lies outside the bundled Horizons snapshot (${horizonStatus.coverage}). Positions shown are the nearest sampled step of that snapshot, not a live query for this date. Use "Refresh live" to query Horizons for this epoch.`
    : null;

  const dataLabel =
    catalogKind === 'live'
      ? 'Catalog live'
      : catalogKind === 'bundled'
        ? 'Catalog snapshot'
        : catalogKind === 'user-upload'
          ? 'User elements'
          : catalogLoading
            ? 'Loading catalog…'
            : 'Catalog unavailable';

  const inspectorBody = useMemo<BodyInspectorData | null>(() => {
    if (!selectedBody) return null;
    const st = ephem[selectedBody];
    const info = BODY_INFO[selectedBody];
    if (!st || !info) return null;
    const earth = ephem.Earth;
    return {
      name: selectedBody,
      kind: info.kind,
      radiusKm: info.radiusKm,
      parent: info.parent,
      distanceFromSunKm: info.kind === 'moon' ? undefined : Math.hypot(st.position.x, st.position.y, st.position.z),
      distanceFromEarthKm: earth
        ? Math.hypot(st.position.x - earth.position.x, st.position.y - earth.position.y, st.position.z - earth.position.z)
        : undefined,
      source: horizonStatus.mode === 'live' ? 'JPL Horizons (live query)' : 'JPL Horizons (bundled snapshot)',
      epochIso: utc(simDate),
      frame: horizonStatus.frame.split(',')[0] ?? 'ICRF/J2000 ecliptic',
      units: 'km heliocentric',
    };
  }, [selectedBody, ephem, horizonStatus, simDate]);

  const inspectorSat = useMemo<SatInspectorData | null>(() => {
    if (!selectedSat) return null;
    const st = catalogStates.find((s) => s.noradId === selectedSat.noradId);
    return {
      name: selectedSat.name,
      noradId: selectedSat.noradId,
      type: selectedSat.type,
      inclinationDeg: selectedSat.inclinationDeg,
      altitudeKm: st?.altitudeKm ?? selectedSat.altitudeKm,
      periodMin: selectedSat.periodMin,
      epochIso: utcShort(new Date(selectedSat.epochIso)),
      positionKm: st?.position ?? { x: 0, y: 0, z: 0 },
      region: regionOf(selectedSat.altitudeKm, selectedSat.inclinationDeg),
      provider: catalogStatus?.provider ?? 'CelesTrak / USSF Space-Track',
      retrievedAt: catalogStatus?.retrievedAt ?? new Date().toISOString(),
    };
  }, [selectedSat, catalogStates, catalogStatus]);

  const sourceBlocks = useMemo<SourceBlock[]>(() => {
    const blocks: SourceBlock[] = [
      {
        title: 'Solar-system body positions',
        kind: horizonStatus.mode === 'live' ? 'live' : horizonStatus.mode === 'bundled' ? 'bundled' : 'unavailable',
        rows: [
          ['Provider', horizonStatus.provider],
          ['API', 'https://ssd-api.jpl.nasa.gov/doc/horizons.html'],
          ['Retrieved', horizonStatus.retrievedAt ? horizonStatus.retrievedAt.replace('T', ' ').slice(0, 19) + 'Z' : '—'],
          ['Coverage', horizonStatus.coverage],
          ['Frame / units', `${horizonStatus.frame} · ${horizonStatus.units}`],
        ],
        note: horizonStatus.detail,
      },
      {
        title: `Earth-orbit catalog · ${catalogStatus?.groupLabel ?? catalogGroup}`,
        kind: catalogKind === 'live' ? 'live' : catalogKind === 'bundled' ? 'bundled' : catalogKind === 'user-upload' ? 'bundled' : 'unavailable',
        rows: [
          ['Provider', catalogStatus?.provider ?? 'not loaded'],
          ['Format docs', 'https://celestrak.org/NORAD/documentation/gp-data-formats.php'],
          ['Retrieved', catalogStatus?.retrievedAt ? catalogStatus.retrievedAt.replace('T', ' ').slice(0, 19) + 'Z' : '—'],
          ['Element epochs', catalogStatus?.elementEpochRange ?? '—'],
          ['Objects', `${catalog.length} tracked objects`],
          ['Frame', 'TEME, Earth-centred (SGP4 output frame)'],
        ],
        note: catalogStatus?.detail ?? (catalogError ?? undefined),
      },
      {
        title: 'Untracked small debris (NASA ODPO)',
        kind: 'info',
        rows: [
          ['Status', 'not integrated'],
          ['Reference', 'https://orbitaldebris.jsc.nasa.gov/modeling/ordem.html'],
          ['Reason', 'No public per-object position data exists for uncataloged fragments; ORDEM software is not distributed as a real-time API.'],
        ],
        note: 'Only tracked catalog objects are rendered, with truthful loaded/visible counts.',
      },
      {
        title: 'Synthetic fallback',
        kind: 'synthetic',
        rows: [
          ['Status', 'never used automatically'],
          ['Policy', 'If neither live nor bundled data is available the app shows an unavailable state instead of inventing catalog records.'],
        ],
      },
    ];
    return blocks;
  }, [horizonStatus, catalogStatus, catalogKind, catalog.length, catalogGroup, catalogError]);

  const scaleLabel =
    scaleInfo.mode === 'overview'
      ? 'Overview · log-compressed distances, enlarged bodies'
      : `Focus · ${scaleInfo.focus} · true local scale`;

  // ── render ─────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="scene-host" ref={hostRef} />

      <div className="labels" aria-hidden>
        {layers.labels &&
          labels.map((l) => (
            <button
              key={l.name}
              className="body-label"
              data-kind={l.kind}
              data-selected={l.selected}
              style={{ left: l.screenX, top: l.screenY }}
              onClick={() => focusBody(l.name)}
            >
              {l.name}
            </button>
          ))}
      </div>

      <div className="overlay">
        <TopBar
          mode={mode}
          onMode={(m) => {
            setMode(m);
            sceneRef.current?.setMode(m);
            if (m === 'mission') {
              setLeftTab('mission');
              if (!origin) {
                const s = LAUNCH_SITES[0];
                setOrigin({ name: s.name, lat: s.lat, lon: s.lon, source: 'site' });
              }
            }
            if (m === 'traffic') {
              setLeftTab('catalog');
              // Frame Earth plus the whole orbital region the traffic lives in.
              sceneRef.current?.frameOrbitalRegion();
            }
          }}
          query={query}
          onQuery={setQuery}
          results={searchResults}
          onResult={onSearchResult}
          epochIso={utc(simDate)}
          dataLabel={dataLabel}
          dataStatus={catalogKind === 'live' || catalogKind === 'bundled' ? 'bundled' : catalogKind === 'user-upload' ? 'bundled' : catalogLoading ? 'unavailable' : 'unavailable'}
          onData={() => setDataPanelOpen((v) => !v)}
        />

        {/* click-mode banner */}
        <div className="banner" data-kind={clickMode === 'inspect' ? 'inspect' : clickMode === 'set_origin' ? 'origin' : 'destination'} role="status">
          {clickMode === 'set_origin' && 'Click the Earth to set a launch origin'}
          {clickMode === 'set_destination' && 'Click a body or satellite to set the destination'}
          {clickMode === 'inspect' && (mode === 'mission' ? 'Mission Planner · click a body to inspect' : mode === 'traffic' ? 'Orbital traffic · inspect any object' : 'Inspect · click a body or drag to orbit')}
          {clickMode !== 'inspect' && (
            <button onClick={() => { setClickMode('inspect'); sceneRef.current?.setClickMode('inspect'); }}>Cancel</button>
          )}
        </div>

        <div className="scale-badge" role="status">
          <strong>{scaleInfo.mode === 'overview' ? 'SOLAR SYSTEM OVERVIEW' : `FOCUS · ${scaleInfo.focus}`}</strong>
          <span>
            {scaleInfo.mode === 'overview'
              ? 'distances log-compressed · bodies enlarged · NOT to scale'
              : 'true local scale · 1 body radius = 300 units'}
          </span>
        </div>

        <LeftPanel
          open={panelOpen}
          tab={leftTab}
          onTab={setLeftTab}
          bodies={SEARCHABLE_BODIES.map((b) => ({
            name: b.name,
            kind: b.kind,
            distanceKm: (() => {
              const st = ephem[b.name];
              if (!st) return undefined;
              const r = Math.hypot(st.position.x, st.position.y, st.position.z);
              return BODY_INFO[b.name]?.kind === 'moon' ? undefined : r;
            })(),
          }))}
          onFocusBody={focusBody}
          onFrameSystem={(name) => {
            sceneRef.current?.frameSystem(name);
            setSelectedBody(name);
            setSelectedSat(null);
          }}
          onOverview={() => { sceneRef.current?.resetCamera(); setSelectedBody(null); }}
          scaleLabel={scaleLabel}
          origin={origin}
          destination={destination}
          onSetOriginMode={() => { setClickMode('set_origin'); sceneRef.current?.setClickMode('set_origin'); sceneRef.current?.flyToBody('Earth'); }}
          onSetDestinationMode={() => { setClickMode('set_destination'); sceneRef.current?.setClickMode('set_destination'); }}
          onClearOrigin={() => setOrigin(null)}
          onClearDestination={() => setDestination(null)}
          launchSites={LAUNCH_SITES}
          onPickSite={(s) => setOrigin({ name: s.name, lat: s.lat, lon: s.lon, source: 'site' })}
          algorithm={algorithm}
          onAlgorithm={(a) => setAlgorithm(a as AlgorithmId)}
          algorithms={ALGORITHM_ORDER.map((id) => ({ ...ALGORITHMS[id] }))}
          costModel={costModelId}
          onCostModel={(id) => setCostModelId(id as CostModelId)}
          costModels={COST_MODELS.map((m) => ({ id: m.id, label: m.label, description: m.description }))}
          keepOutKm={keepOutKm}
          onKeepOutKm={setKeepOutKm}
          keepOutChoices={[...KEEP_OUT_CHOICES]}
          hazardInfo={
            missionGraph
              ? {
                  screened: missionGraph.stats.screenedObjects,
                  blockedEdges: missionGraph.stats.blockedEdges,
                  graphEdges: missionGraph.stats.edges,
                }
              : null
          }
          onPlan={() => runPlanner(algorithm)}
          onCompareAll={runCompare}
          planning={planning}
          catalogGroup={catalogGroup}
          onCatalogGroup={setCatalogGroup}
          groups={[...CATALOG_MIX_DEFS, ...CATALOG_GROUPS]}
          catalogLoading={catalogLoading}
          counts={{
            loaded: sceneCounts.loaded,
            visible: sceneCounts.matching,
            filteredOut: Math.max(0, sceneCounts.loaded - sceneCounts.matching),
          }}
          catalogStatus={catalogStatus}
          onImportTle={(file) => {
            const reader = new FileReader();
            reader.onload = () => {
              const res = parseUserElements(String(reader.result), file.name);
              if (res.objects.length > 0) applyCatalog(res.objects, res.status);
              else setCatalogError(`No usable TLE records found in ${file.name}.`);
            };
            reader.readAsText(file);
          }}
          onRefreshLive={refreshLive}
          filters={{
            payload: filters.payload,
            rocketBody: filters.rocketBody,
            debris: filters.debris,
            regions: [...filters.regions],
            nameQuery: filters.nameQuery,
          }}
          onFilters={(f) => setFilters({ ...f, regions: new Set(f.regions) })}
          regionOptions={['LEO', 'MEO', 'GEO', 'HEO', 'other']}
          layers={[
            { id: 'orbits', label: 'Orbit lines', hint: 'JPL approximate Keplerian elements', value: layers.orbits },
            { id: 'labels', label: 'Body labels', hint: 'Collision-avoiding screen labels', value: layers.labels },
            { id: 'satellites', label: 'Cataloged objects', hint: `${fmt(sceneCounts.matching)} of ${fmt(sceneCounts.loaded)} match the filters · rendered in Earth focus`, value: layers.satellites },
            { id: 'route', label: 'Route overlay', hint: 'Conceptual AI graph route', value: layers.route },
          ]}
          onLayer={(id, v) => setLayers((l) => ({ ...l, [id]: v }))}
        />

        <button
          className="panel-toggle"
          onClick={() => setPanelOpen((v) => !v)}
          aria-label={panelOpen ? 'Collapse control panel' : 'Expand control panel'}
        >
          {panelOpen ? '‹' : '›'}
        </button>

        {mode === 'traffic' && (
          <TrafficPanel
            running={trafficRunning}
            onStart={startTraffic}
            onStop={stopTraffic}
            onStep={() => { stopTraffic(); stepDStar(); }}
            onReset={() => { stopTraffic(); resetDStar(); }}
            onReplay={() => {
              stopTraffic();
              resetDStar();
              if (!dstarInitialSnapshot) return;
              const snap = dstarInitialSnapshot;
              const d = new DStarLite({
                grid: snap.grid,
                seed: snap.seed,
                manoeuvringCount: 4,
                manoeuvreProbability: 0.18,
              });
              d.epochMs = snap.epochMs;
              d.replay(snap, DSTAR_START_CELL, DSTAR_GOAL_CELL);
              // A deterministic replay also restores the simulation epoch.
              setSimDate(new Date(snap.epochMs));
              dstarPropRef.current = new Sgp4Propagator(catalog.slice(0, DSTAR_OBJECT_CAP));
              dstarRef.current = d;
              setDstarEvents(d.events_.map((e) => ({ ...e })));
              setDstarReport({
                replans: 0,
                changedEdges: 0,
                expandedInRepair: 0,
                pathCost: d.pathCost(),
                pathLength: d.path().length,
                wallMs: 0,
              });
            }}
            speed={trafficSpeed}
            onSpeed={setTrafficSpeed}
            counts={{ loaded: catalog.length, modelled: Math.min(catalog.length, DSTAR_OBJECT_CAP) }}
            report={dstarReport}
            events={dstarEvents}
            status={catalogStatus}
            grid={DSTAR_GRID}
            startCell={DSTAR_START_CELL}
            goalCell={DSTAR_GOAL_CELL}
          />
        )}

        <Inspector
          body={inspectorBody}
          sat={inspectorSat}
          onClose={() => { setSelectedBody(null); setSelectedSat(null); sceneRef.current?.select(null); }}
          onFocus={() => {
            if (selectedBody) focusBody(selectedBody);
            else if (selectedSat) sceneRef.current?.flyToSatellite(selectedSat);
          }}
          onSetDestination={() => {
            if (selectedBody) setDestinationFromScene(selectedBody, 'body', new THREE.Vector3());
            else if (selectedSat) setDestinationFromScene(selectedSat.name, 'satellite', new THREE.Vector3());
            setLeftTab('mission');
            setMode('mission');
          }}
          onTrack={() => selectedSat && sceneRef.current?.flyToSatellite(selectedSat)}
        />

        <DataPanel
          open={dataPanelOpen}
          onClose={() => setDataPanelOpen(false)}
          blocks={sourceBlocks}
          requestedEpoch={simDate.toISOString()}
          staleWarning={[coverageWarning, catalogStaleWarning].filter(Boolean).join('\n\n') || null}
        />

        <TimeBar
          iso={utc(simDate)}
          playing={playing}
          speed={speed}
          onPlay={() => setPlaying((v) => !v)}
          onSpeed={setSpeed}
          onStep={(sec) => setSimDate((d) => new Date(d.getTime() + sec * 1000))}
          onNow={() => setSimDate(new Date())}
          onPick={(iso) => setSimDate(new Date(iso))}
        />

        {plan && (
          <PlanSummary
            plan={plan}
            compare={compare}
            graphVersion={missionGraph?.version ?? ''}
            costModel={costModel(costModelId)}
            originName={origin?.name ?? '—'}
            destinationName={destination?.name ?? '—'}
            missionGraph={missionGraph}
          />
        )}

        <div className="hints">
          Scroll = zoom · drag = orbit · shift/right-drag = pan · double-click = fly to
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const PlanSummary: React.FC<{
  plan: PlanResult;
  compare: PlanResult[] | null;
  graphVersion: string;
  costModel: { label: string; description: string };
  originName: string;
  destinationName: string;
  missionGraph: MissionGraph | null;
}> = ({ plan, compare, graphVersion, costModel, originName, destinationName, missionGraph }) => {
  return (
    <section
      aria-label="Route result"
      style={{
        position: 'absolute', right: 12, bottom: 110, width: 300, zIndex: 16,
        background: 'var(--bg-panel)', border: '1px solid var(--border)',
        borderRadius: 12, boxShadow: 'var(--shadow)', padding: 12,
        display: 'flex', flexDirection: 'column', gap: 8, backdropFilter: 'blur(18px)',
        maxHeight: '52vh', overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent)' }}>
          Route result
        </strong>
        <Tag label="conceptual AI graph route" kind="planet" />
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
        {originName} → {destinationName}
      </div>
      <div className="grid2">
        <Stat label="Cost" value={fmt(plan.metrics.pathCost, 1)} />
        <Stat label="Δv proxy" value={`${fmt(plan.metrics.deltaVTotalMs)} m/s`} color="var(--warn)" />
      </div>
      <div className="grid3">
        <Stat label="Duration" value={fmtDuration(plan.metrics.durationHours * 3600)} color="var(--good)" />
        <Stat label="Stages" value={plan.metrics.edgeCount} color="var(--accent)" />
        <Stat label="Expanded" value={fmt(plan.metrics.expandedNodes)} color="var(--traffic)" />
      </div>
      <div className="grid3">
        <Stat label="Plan time" value={`${plan.metrics.planningTimeMs.toFixed(2)} ms`} color="var(--traffic)" />
        <Stat label="Peak frontier" value={fmt(plan.metrics.peakFrontier)} color="var(--accent)" />
        <Stat label="Min miss" value={plan.metrics.minMissKm > 0 ? `${fmt(plan.metrics.minMissKm)} km` : '—'} color="var(--bad)" />
      </div>
      <div className="note">
        <strong>Obstacle screening.</strong> {missionGraph
          ? `${missionGraph.stats.screenedObjects} cataloged objects screened · ${missionGraph.stats.blockedEdges} of ${missionGraph.stats.edges} graph edges inside the keep-out radius · ${plan.metrics.clearedObstacles ? 'route clears every keep-out sphere' : 'route clips a keep-out sphere'}.`
          : 'No catalog loaded, so no obstacles were screened.'}
        {' '}Keep-out spheres drawn in the scene are the volumes the search had to route around.
      </div>
      {plan.found ? (
        <ol style={{ margin: 0, paddingLeft: 16, fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.7 }}>
          {plan.path.map((n) => (
            <li key={n.id}>{n.name}</li>
          ))}
        </ol>
      ) : (
        <div className="note bad">
          No route found for this origin/destination pair on the current graph. The graph connects
          surface sites, parking shells and one destination; try another destination or cost model.
        </div>
      )}
      <div className="note">
        <strong>Algorithm:</strong> {plan.metrics.algorithm}
        <br />
        <strong>Optimality:</strong> {plan.metrics.optimality}
        <br />
        <strong>Cost model:</strong> {costModel.label} — {costModel.description}
        <br />
        <strong>Graph:</strong> {graphVersion}
        <br />
        This is a graph search over an abstract mission navigation graph. It is not a verified
        trajectory, Δv budget or conjunction assessment.
      </div>
      {compare && compare.length > 1 && (
        <>
          <div className="section-title" style={{ marginTop: 2 }}>Algorithm comparison</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
            <thead>
              <tr style={{ color: 'var(--text-faint)', textAlign: 'left' }}>
                <th style={{ padding: '2px 4px' }}>Algo</th>
                <th style={{ padding: '2px 4px', textAlign: 'right' }}>Cost</th>
                <th style={{ padding: '2px 4px', textAlign: 'right' }}>Nodes</th>
                <th style={{ padding: '2px 4px', textAlign: 'right' }}>ms</th>
              </tr>
            </thead>
            <tbody>
              {compare.map((r) => (
                <tr key={r.algorithm} style={{ color: r.found ? 'var(--text)' : 'var(--bad)' }}>
                  <td style={{ padding: '2px 4px' }}>{ALGORITHMS[r.algorithm].short}</td>
                  <td style={{ padding: '2px 4px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    {r.found ? fmt(r.metrics.pathCost, 1) : 'none'}
                  </td>
                  <td style={{ padding: '2px 4px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmt(r.metrics.expandedNodes)}</td>
                  <td style={{ padding: '2px 4px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    {r.metrics.planningTimeMs.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const TrafficPanel: React.FC<{
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  onStep: () => void;
  onReset: () => void;
  onReplay: () => void;
  speed: number;
  onSpeed: (v: number) => void;
  counts: { loaded: number; modelled: number };
  report: { replans: number; changedEdges: number; expandedInRepair: number; pathCost: number; pathLength: number; wallMs: number } | null;
  events: { type: string; message: string; timeSec: number }[];
  status: CatalogStatus | null;
  grid: OrbitGridSpec;
  startCell: [number, number, number];
  goalCell: [number, number, number];
}> = ({ running, onStart, onStop, onStep, onReset, onReplay, speed, onSpeed, counts, report, events, status, grid, startCell, goalCell }) => {
  const startKm = cellCentre(grid, startCell[0], startCell[1], startCell[2]);
  const goalKm = cellCentre(grid, goalCell[0], goalCell[1], goalCell[2]);
  return (
    <section className="traffic-panel" aria-label="Orbital traffic and D star Lite simulation">
      <strong style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--traffic)' }}>
        Orbital traffic · D* Lite
      </strong>
      <div className="note">
        Time-expanded occupancy graph: {grid.altBands}×{grid.azSectors}×{grid.polarSectors} cells ×{' '}
        {grid.timeSteps} steps of {grid.stepSec}s. {counts.modelled} of {counts.loaded} cataloged
        objects are propagated into the occupancy model (nearest-first cap).
        <br />
        Simulated vehicle: {fmt(Math.hypot(startKm.x, startKm.y, startKm.z))} km →{' '}
        {fmt(Math.hypot(goalKm.x, goalKm.y, goalKm.z))} km from Earth's centre.
        <br />
        <Tag label="educational model" kind="moon" /> Collision avoidance and transfer dynamics are
        simplified; this is not a conjunction assessment.
      </div>
      <div className="btn-row">
        <button className={running ? 'btn' : 'btn btn-traffic'} onClick={running ? onStop : onStart}>
          {running ? '⏹ Stop simulation' : '▶ Start orbital simulation'}
        </button>
        <button className="btn" onClick={onStep} aria-label="Single step">Step</button>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={onReplay}>Replay snapshot</button>
        <button className="btn" onClick={onReset}>Reset</button>
      </div>
      <div className="chip-grid">
        {[0.5, 1, 2, 4].map((s) => (
          <button key={s} className="chip" aria-pressed={speed === s} onClick={() => onSpeed(s)}>
            {s}× speed
          </button>
        ))}
      </div>
      {report && (
        <div className="grid3">
          <Stat label="Replans" value={fmt(report.replans)} color="var(--warn)" />
          <Stat label="Changed cells" value={fmt(report.changedEdges)} color="var(--traffic)" />
          <Stat label="Route cost" value={fmt(report.pathCost, 1)} color="var(--accent)" />
        </div>
      )}
      {report && (
        <div className="grid3">
          <Stat label="Last repair" value={`${report.expandedInRepair} nodes`} color="var(--accent)" />
          <Stat label="Waypoints" value={report.pathLength} color="var(--good)" />
          <Stat label="Repair time" value={`${report.wallMs.toFixed(1)} ms`} color="var(--traffic)" />
        </div>
      )}
      <div>
        <div className="section-title">Event log ({events.length})</div>
        <div className="log">
          {events.length === 0 && <div className="log-line">Start the simulation to see D* Lite repairs.</div>}
          {events.map((e, i) => (
            <div className="log-line" data-type={e.type} key={i}>
              <span style={{ color: 'var(--text-faint)' }}>+{Math.floor(e.timeSec / 60)}m</span> {e.message}
            </div>
          ))}
        </div>
      </div>
      <div className="note">
        Provider: {status?.provider ?? '—'}
        <br />
        Element epochs: {status?.elementEpochRange ?? '—'}
        <br />
        Cataloged objects are propagated with their published elements. A small, seeded subset is
        perturbed each step to model maneuvering objects so the dynamic replanning is observable;
        replays use the same seed and are deterministic.
      </div>
    </section>
  );
};

export default App;
