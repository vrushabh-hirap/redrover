/**
 * RedRover scene — one WebGL renderer, one render loop, three modes.
 *
 * The scene owns:
 *   • the camera rig (orbit / pan / zoom with damping, smooth fly-to)
 *   • the two named scale modes (overview / focus) and the mapping between km
 *     data coordinates and scene coordinates
 *   • body meshes, orbit lines, moon systems and satellite instancing
 *   • picking (bodies, Earth surface, satellites) and route overlays
 *
 * It deliberately never calls React setState from the render loop. Label
 * positions are published to the UI layer on a throttle.
 */

import * as THREE from 'three';
import { CatalogObject, PropagatedState } from '../data/types';
import { HorizonsEphemeris, BODY_MOONS, BODY_PARENT } from '../data/horizons';
import { cellCentre } from '../planners/dStarLite';
import { EARTH_RADIUS_KM, Sgp4Propagator, gmst } from '../orbit/sgp4';
import {
  BODY_INFO,
  BODY_ORDER,
  ScaleMode,
  SatelliteFilter,
  EMPTY_FILTER,
  matchesFilter,
  overviewMoonOrbit,
  overviewOffset,
  overviewPosition,
  overviewVisualRadius,
  unitsPerKm,
  focusPosition,
  orbitPointsAu,
  overviewRadial,
  temeToEci,
  exaggerationFactor,
} from './scale';

export type SceneMode = 'explorer' | 'mission' | 'traffic';
export type ClickMode = 'inspect' | 'set_origin' | 'set_destination';

export interface SceneLabel {
  name: string;
  sub?: string;
  screenX: number;
  screenY: number;
  kind: 'star' | 'planet' | 'moon' | 'satellite';
  distanceKm?: number;
  selected: boolean;
}

export interface BodyWorld {
  name: string;
  scenePos: THREE.Vector3;
  visualRadius: number;
  trueRadiusKm: number;
}

export interface RouteSegment {
  from: THREE.Vector3;
  to: THREE.Vector3;
}

const COLORS = {
  payload: 0x22d3ee,
  rocketBody: 0xfbbf24,
  debris: 0xf472b6,
  selection: 0x7dd3fc,
  satellite: 0x22d3ee,
  route: 0x38bdf8,
  routeAlt: 0xa78bfa,
  explored: 0xf87171,
  origin: 0x22c55e,
  destination: 0xf59e0b,
};

export class SolarScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private container: HTMLElement;
  private labelHost: HTMLElement;

  // ── data ──
  private horizons: HorizonsEphemeris;
  private propagator: Sgp4Propagator | null = null;
  private catalog: CatalogObject[] = [];
  private catalogStates: PropagatedState[] = [];
  private simDate = new Date();
  private helio = new Map<string, THREE.Vector3>();
  private gmstRad = 0;

  // ── scene graph ──
  private bodyGroups = new Map<string, THREE.Group>();
  private bodyMeshes = new Map<string, THREE.Mesh>();
  private orbitLines: THREE.Line[] = [];
  private moonOrbits: THREE.Line[] = [];
  private selectionHalo: THREE.Mesh;
  private satHalo: THREE.Mesh;
  private originMarker: THREE.Mesh;
  private destinationMarker: THREE.Mesh;
  private routeGroup = new THREE.Group();
  private waypointGroup = new THREE.Group();
  private exploredPoints: THREE.Points | null = null;
  private satelliteGroup = new THREE.Group();
  private satInstances = new Map<string, THREE.InstancedMesh>();
  private satPoints: THREE.Points | null = null;
  private satPointsGeom: THREE.BufferGeometry | null = null;
  private satIndex = new Map<string, { obj: CatalogObject; slot: number }>();

  // ── scale / camera ──
  private scaleMode: ScaleMode = 'overview';
  private focusBody: string | null = null;
  private focusOriginKm = new THREE.Vector3();
  private kmPerUnit = 1 / 300;
  readonly camTarget = new THREE.Vector3();
  private camTargetGoal = new THREE.Vector3();
  private camDist = 380;
  private camDistGoal = 380;
  private camTheta = 0.6;
  private camPhi = 1.0;
  private camThetaGoal = 0.6;
  private camPhiGoal = 1.0;
  private flying = false;
  private minDist = 3;
  private maxDist = 40_000;

  // ── input ──
  private pointerDown = false;
  private pointerButton = 0;
  private lastPointer = { x: 0, y: 0 };
  private downPointer = { x: 0, y: 0 };
  private movedDistance = 0;
  private raycaster = new THREE.Raycaster();
  private sunLight!: THREE.PointLight;
  private ambient!: THREE.AmbientLight;
  private fill!: THREE.DirectionalLight;
  private pointerNdc = new THREE.Vector2();

  // ── callbacks ──
  onLabels?: (labels: SceneLabel[]) => void;
  onSelectBody?: (name: string) => void;
  onSelectSatellite?: (obj: CatalogObject, state: PropagatedState | null) => void;
  onPickOrigin?: (lat: number, lon: number, label: string) => void;
  onPickDestination?: (name: string, kind: 'body' | 'satellite', posKm: THREE.Vector3) => void;
  onCameraChange?: (info: { scaleMode: ScaleMode; focusBody: string | null; distanceUnits: number; exaggeration: string }) => void;

  // ── runtime ──
  private rafId = 0;
  private frame = 0;
  private disposed = false;
  private labelThrottle = 0;
  private selected: string | null = null;
  private hoverFilter: SatelliteFilter = EMPTY_FILTER;
  private catalogFilter: SatelliteFilter = EMPTY_FILTER;
  private routeLines: THREE.Line[] = [];
  private waypointMarkers: THREE.Mesh[] = [];

  constructor(
    container: HTMLElement,
    labelHost: HTMLElement,
    horizons: HorizonsEphemeris,
    date: Date,
  ) {
    this.container = container;
    this.labelHost = labelHost;
    this.horizons = horizons;
    this.simDate = date;

    this.scene.background = new THREE.Color(0x03050d);
    const w = container.clientWidth || 1280;
    const h = container.clientHeight || 800;
    this.camera = new THREE.PerspectiveCamera(52, w / Math.max(1, h), 0.05, 20_000_000);
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    this.buildLights();
    this.buildStarfield();
    this.buildBodies();
    this.buildOrbitLines();
    this.buildHelpers();
    this.buildSatelliteGroup();

    this.selectionHalo = this.makeHalo(COLORS.selection);
    this.satHalo = this.makeHalo(COLORS.satellite);
    this.originMarker = this.makeHalo(COLORS.origin);
    this.destinationMarker = this.makeHalo(COLORS.destination);

    this.updateForDate(date);
    this.applyCamera();
    this.bindInput();
    this.frameOverview();
    this.loop();
  }

  // ── construction ───────────────────────────────────────────────────────────

  private buildLights(): void {
    this.ambient = new THREE.AmbientLight(0x22314f, 1.35);
    this.scene.add(this.ambient);
    // Sunlight physically originates at the Sun; updateForDate() keeps it there
    // in whichever scale mapping is active.
    this.sunLight = new THREE.PointLight(0xfff4e2, 3.1, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.HemisphereLight(0x16233c, 0x05070f, 0.9));
    this.fill = new THREE.DirectionalLight(0x7c92c4, 0.2);
    this.scene.add(this.fill);
  }

  private buildStarfield(): void {
    // Two layers: a bright sparse layer and a dim dense one, both as a single
    // Points draw call each. Positions live on a large sphere.
    const make = (n: number, size: number, opacity: number, dim: boolean) => {
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = 900_000 + Math.random() * 400_000;
        const t = Math.random() * Math.PI * 2;
        const p = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(p) * Math.cos(t);
        pos[i * 3 + 1] = r * Math.cos(p);
        pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
        const b = dim ? 0.35 + Math.random() * 0.3 : 0.6 + Math.random() * 0.4;
        const warm = Math.random();
        col[i * 3] = b * (warm > 0.8 ? 1 : 0.85);
        col[i * 3 + 1] = b * 0.9;
        col[i * 3 + 2] = b;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.PointsMaterial({
        size,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      this.scene.add(new THREE.Points(g, m));
    };
    make(3_000, 2.0, 0.9, false);
    make(9_000, 1.2, 0.5, true);
  }

  private buildBodies(): void {
    for (const name of BODY_ORDER) {
      const info = BODY_INFO[name];
      const group = new THREE.Group();
      group.name = name;
      const geo = new THREE.SphereGeometry(overviewVisualRadius(name), 48, 24);
      const mat =
        info.kind === 'star'
          ? new THREE.MeshBasicMaterial({ color: 0xffd166 })
          : new THREE.MeshStandardMaterial({
              color: new THREE.Color(BODY_COLOR[name] ?? 0x8899aa),
              roughness: info.kind === 'moon' ? 0.95 : 0.72,
              metalness: 0.02,
            });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.bodyName = name;
      group.add(mesh);
      this.bodyGroups.set(name, group);
      this.bodyMeshes.set(name, mesh);
      this.scene.add(group);

      if (info.kind === 'star') {
        const sprite = this.makeGlowSprite(overviewVisualRadius(name) * 6);
        group.add(sprite);
      }
      if (name === 'Earth') {
        group.add(this.makeAtmosphere(overviewVisualRadius(name)));
      }
      if (name === 'Saturn') {
        group.add(this.makeSaturnRing(overviewVisualRadius(name)));
      }
    }
  }

  private makeGlowSprite(size: number): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const x = c.getContext('2d')!;
    const g = x.createRadialGradient(128, 128, 4, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,238,180,0.95)');
    g.addColorStop(0.25, 'rgba(255,196,90,0.45)');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    sprite.scale.set(size, size, 1);
    return sprite;
  }

  private makeAtmosphere(r: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.028, 40, 20),
      new THREE.MeshBasicMaterial({
        color: 0x63b8ff,
        transparent: true,
        opacity: 0.13,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    return mesh;
  }

  private makeSaturnRing(r: number): THREE.Mesh {
    const geo = new THREE.RingGeometry(r * 1.4, r * 2.3, 96, 1);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const d = Math.sqrt(x * x + z * z);
      uv.setXY(i, (d - r * 1.4) / (r * 0.9), 0.5);
    }
    uv.needsUpdate = true;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 1;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 128, 0);
    g.addColorStop(0, 'rgba(210,180,120,0)');
    g.addColorStop(0.25, 'rgba(214,186,128,0.55)');
    g.addColorStop(0.6, 'rgba(232,212,160,0.8)');
    g.addColorStop(1, 'rgba(200,170,110,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 1);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = Math.PI / 2.15;
    return mesh;
  }

  private buildOrbitLines(): void {
    const now = this.simDate;
    for (const name of Object.keys(BODY_INFO)) {
      if (BODY_INFO[name].kind !== 'planet' && name !== 'Sun') continue;
      const pts = orbitPointsAu(name, now, 220);
      if (pts.length < 2) continue;
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: BODY_ORBIT_COLOR[name] ?? 0x2a3a55,
        transparent: true,
        opacity: 0.55,
      });
      const line = new THREE.Line(geo, mat);
      line.userData.bodyName = name;
      this.orbitLines.push(line);
      this.scene.add(line);
    }
    for (const name of BODY_ORDER) {
      if (!BODY_PARENT[name] || BODY_INFO[name].kind !== 'moon') continue;
      const parentGroup = this.bodyGroups.get(BODY_PARENT[name]);
      if (!parentGroup) continue;
      const r = overviewMoonOrbit(name);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a) * 0.12, r * Math.sin(a)));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x475a78, transparent: true, opacity: 0.4 }),
      );
      line.userData.parent = BODY_PARENT[name];
      line.userData.moonName = name;
      this.moonOrbits.push(line);
      this.scene.add(line);
    }
  }

  private makeHalo(color: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1.0, 64),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    mesh.visible = false;
    mesh.renderOrder = 10;
    this.scene.add(mesh);
    return mesh;
  }

  private buildHelpers(): void {
    this.scene.add(this.routeGroup);
    this.scene.add(this.waypointGroup);
  }

  private buildSatelliteGroup(): void {
    this.scene.add(this.satelliteGroup);
  }

  // ── public API ─────────────────────────────────────────────────────────────

  setCatalog(catalog: CatalogObject[], date: Date): void {
    this.catalog = catalog;
    this.propagator = new Sgp4Propagator(catalog);
    this.rebuildSatelliteInstances();
    this.updateCatalogPositions(date);
  }

  /** Objects that pass the current filters (rendered when in an Earth focus). */
  get matchingCount(): number {
    let n = 0;
    for (const o of this.catalog) if (matchesFilter(o, this.catalogFilter)) n++;
    return n;
  }

  setSimDate(date: Date): void {
    this.simDate = date;
    this.updateForDate(date);
  }

  setMode(_mode: SceneMode): void {
    // Mode only affects UI affordances; the renderer is shared.
  }

  clickMode: ClickMode = 'inspect';

  setClickMode(m: ClickMode): void {
    this.clickMode = m;
  }

  setFilter(filter: SatelliteFilter): void {
    this.catalogFilter = filter;
    this.rebuildSatelliteInstances();
    this.updateCatalogPositions(this.simDate);
  }

  /** Positions for the current date, plus body screen positions. */
  updateForDate(date: Date): void {
    this.simDate = date;
    const states = this.horizons.statesAt(date);
    this.helio.clear();
    for (const [name, st] of Object.entries(states ?? {})) {
      this.helio.set(name, new THREE.Vector3(st.position.x, st.position.y, st.position.z));
    }
    this.gmstRad = gmst(date);
    // The point light is physically at the Sun, so it must be re-placed in the
    // active scale mapping whenever the mapping or the epoch changes.
    this.sunLight.position.copy(this.bodyGroups.get('Sun')?.position ?? new THREE.Vector3());

    const earthHelio = this.helio.get('Earth') ?? new THREE.Vector3();
    if (this.scaleMode === 'overview') {
      this.focusOriginKm.copy(earthHelio);
      for (const name of BODY_ORDER) {
        const group = this.bodyGroups.get(name);
        if (!group) continue;
        const h = this.helio.get(name);
        if (!h) continue;
        if (name === 'Sun') {
          group.position.set(0, 0, 0);
          continue;
        }
        if (BODY_INFO[name].kind === 'moon' && BODY_PARENT[name]) {
          const parent = this.helio.get(BODY_PARENT[name]);
          if (parent) group.position.copy(overviewPosition(parent)).add(overviewOffset(h.clone().sub(parent), overviewMoonOrbit(name)));
          continue;
        }
        group.position.copy(overviewPosition(h));
      }
      for (const line of this.moonOrbits) {
        const parent = line.userData.parent as string;
        line.position.copy(this.bodyGroups.get(parent)?.position ?? new THREE.Vector3());
      }
    } else if (this.scaleMode === 'focus' && this.focusBody) {
      const origin = this.helio.get(this.focusBody);
      if (origin) {
        this.focusOriginKm.copy(origin);
        this.kmPerUnit = unitsPerKm(this.focusBody);
        for (const name of BODY_ORDER) {
          const group = this.bodyGroups.get(name);
          const h = this.helio.get(name);
          if (!group || !h) continue;
          group.position.copy(focusPosition(h, origin, this.kmPerUnit));
        }
        // Moon orbit rings follow the true local scale in focus mode.
        for (const line of this.moonOrbits) {
          const parent = line.userData.parent as string;
          const moonName = line.userData.moonName as string;
          line.position.copy(this.bodyGroups.get(parent)?.position ?? new THREE.Vector3());
          // The geometry was authored at overviewMoonOrbit(moonName) units.
          const authored = overviewMoonOrbit(moonName);
          const parentR = BODY_INFO[parent]?.radiusKm ?? 6371;
          const target = parentR * 2.4 * this.kmPerUnit;
          line.scale.setScalar(Math.max(0.02, target / authored));
        }
      }
    }

    this.updateCatalogPositions(date);
    this.refreshOrbitLinesForScale();
    this.applyBodyScales();
    this.applyBodyVisibility();
  }

  /**
   * Body meshes were authored at the OVERVIEW visual radius. In FOCUS mode each
   * body must render at its true scaled radius instead.
   */
  private applyBodyScales(): void {
    for (const [name, mesh] of this.bodyMeshes) {
      const authored = overviewVisualRadius(name);
      const target =
        this.scaleMode === 'overview' ? authored : BODY_INFO[name].radiusKm * this.kmPerUnit;
      mesh.scale.setScalar(Math.max(1e-4, target / authored));
    }
  }

  /** Hide bodies far outside the viewport so the far plane never clips them. */
  private applyBodyVisibility(): void {
    const limit = 8_000_000;
    for (const name of BODY_ORDER) {
      const group = this.bodyGroups.get(name);
      if (!group) continue;
      const d = group.position.distanceTo(this.camera.position);
      const r = this.bodyVisualUnits(name);
      group.visible = d < limit && r / Math.max(1, d) > 1e-6;
    }
    // Catalog objects are only rendered in an Earth-centred focus; in overview
    // they would collapse onto Earth's position and be meaningless.
    this.satelliteGroup.visible = this.scaleMode === 'focus' && this.focusBody === 'Earth';
  }

  /** Scene unit radius of a moon's orbit ring in the active scale mode. */
  private moonOrbitUnits(moonName: string): number {
    if (this.scaleMode === 'focus') {
      const parentR = BODY_INFO[BODY_PARENT[moonName] ?? 'Earth']?.radiusKm ?? 6371;
      return parentR * 2.4 * this.kmPerUnit;
    }
    return overviewMoonOrbit(moonName);
  }

  /** Reset moon orbit rings to their authored size (used when leaving focus). */
  private resetMoonOrbitScale(): void {
    for (const line of this.moonOrbits) {
      line.scale.setScalar(1);
    }
  }

  private refreshOrbitLinesForScale(): void {
    for (const line of this.orbitLines) {
      const name = line.userData.bodyName as string;
      if (BODY_INFO[name]?.kind !== 'planet') continue;
      if (this.scaleMode === 'overview') {
        this.applyRadialToLine(line);
      } else {
        line.visible = false;
      }
    }
    for (const line of this.moonOrbits) {
      const parent = line.userData.parent as string;
      line.position.copy(this.bodyGroups.get(parent)?.position ?? new THREE.Vector3());
      const moonName = line.userData.moonName as string;
      const authored = overviewMoonOrbit(moonName);
      line.scale.setScalar(Math.max(0.02, this.moonOrbitUnits(moonName) / authored));
      // Hide moon rings of systems we are not focused on.
      const focused = this.focusBody;
      const parentOfFocus = focused ? BODY_PARENT[focused] : null;
      const relevant =
        !focused ||
        parent === focused ||
        moonName === focused ||
        (parentOfFocus && parent === parentOfFocus);
      line.visible = !!relevant;
    }
  }

  private applyRadialToLine(line: THREE.Line): void {
    const pos = line.geometry.attributes.position as THREE.BufferAttribute;
    if (!line.userData.original) {
      line.userData.original = (pos.array as Float32Array).slice();
    }
    const original = line.userData.original as Float32Array;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(original[i * 3], original[i * 3 + 1], original[i * 3 + 2]);
      const r = v.length();
      if (r > 1e-9) v.multiplyScalar(overviewRadial(r) / r);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  updateCatalogPositions(date: Date): void {
    if (!this.propagator) return;
    this.catalogStates = this.propagator.propagateBatch(date);
    const earthHelio = this.helio.get('Earth') ?? new THREE.Vector3();
    const posArr: number[] = [];
    const colArr: number[] = [];

    for (const st of this.catalogStates) {
      const meta = this.satIndex.get(String(st.noradId));
      if (!meta) continue;
      const obj = meta.obj;
      if (!matchesFilter(obj, this.catalogFilter)) continue;
      const eci = temeToEci(new THREE.Vector3(st.position.x, st.position.y, st.position.z), this.gmstRad);
      const scene = this.mapEarthOrbit(eci, earthHelio);
      posArr.push(scene.x, scene.y, scene.z);
      const c = new THREE.Color(COLORS[obj.type === 'rocket_body' ? 'rocketBody' : obj.type]);
      colArr.push(c.r, c.g, c.b);
    }

    // Points draw call for every visible object (cheap, single buffer).
    if (this.satPoints) {
      this.satelliteGroup.remove(this.satPoints);
      this.satPoints.geometry.dispose();
      (this.satPoints.material as THREE.Material).dispose();
      this.satPoints = null;
    }
    if (posArr.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
      const m = new THREE.PointsMaterial({
        // Marker size is enlarged for legibility; positions are exact.
        size: 5,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      this.satPoints = new THREE.Points(g, m);
      this.satelliteGroup.add(this.satPoints);
    }
  }

  /** Objects passing the current filters, in the same order as the point cloud. */
  private get visibleList(): CatalogObject[] {
    return this.catalog.filter((o) => matchesFilter(o, this.catalogFilter));
  }

  private mapEarthOrbit(eci: THREE.Vector3, earthHelio: THREE.Vector3): THREE.Vector3 {
    if (this.scaleMode === 'overview') {
      // Satellites only exist in focus mode.
      const helio = eci.clone().add(earthHelio);
      const r = helio.length();
      return helio.multiplyScalar(overviewRadial(r) / Math.max(1e-9, r));
    }
    return eci.clone().multiplyScalar(this.kmPerUnit);
  }

  private rebuildSatelliteInstances(): void {
    this.satIndex.clear();
    this.catalog.forEach((o, i) => this.satIndex.set(String(o.noradId), { obj: o, slot: i }));
  }

  // ── camera ─────────────────────────────────────────────────────────────────

  private applyCamera(): void {
    const sinPhi = Math.sin(this.camPhi);
    this.camera.position.set(
      this.camTarget.x + this.camDist * sinPhi * Math.cos(this.camTheta),
      this.camTarget.y + this.camDist * Math.cos(this.camPhi),
      this.camTarget.z + this.camDist * sinPhi * Math.sin(this.camTheta),
    );
    this.camera.lookAt(this.camTarget);
    this.camera.updateMatrixWorld();
  }

  /** Fly to a body: switch to focus mode on it and animate the camera. */
  flyToBody(name: string): void {
    if (!this.bodyGroups.has(name)) return;
    this.scaleMode = 'focus';
    this.focusBody = name;
    this.updateForDate(this.simDate);
    const pos = this.bodyGroups.get(name)!.position.clone();
    this.camTargetGoal.copy(pos);
    const r = this.bodyVisualUnits(name);
    this.camDistGoal = Math.max(this.minDist, r * 6.5);
    this.camDistGoal = Math.min(this.camDistGoal, 1_200_000);
    this.clampDistances();
    this.flying = true;
    this.selected = name;
    this.emitCameraInfo();
  }

  /**
   * Frame a body together with its moon system. The Moon is 60 Earth radii
   * away, so this necessarily shows the planet small — it is the honest
   * "system" framing, complementing the close-up `flyToBody`.
   */
  frameSystem(name: string): void {
    if (!this.bodyGroups.has(name)) return;
    this.scaleMode = 'focus';
    this.focusBody = name;
    this.updateForDate(this.simDate);
    let reach = this.bodyVisualUnits(name);
    for (const other of BODY_MOONS[name] ?? []) {
      const d = this.bodyGroups.get(other)!.position.length() + this.bodyVisualUnits(other);
      reach = Math.max(reach, d);
    }
    this.camTargetGoal.set(0, 0, 0);
    this.camTarget.set(0, 0, 0);
    const vFov = (this.camera.fov * Math.PI) / 360;
    const hFov = Math.atan(Math.tan(vFov) * Math.max(0.4, this.camera.aspect));
    this.camDistGoal = (reach / Math.sin(Math.min(vFov, hFov))) * 1.05;
    this.clampDistances();
    this.flying = true;
    this.selected = name;
    this.emitCameraInfo();
  }

  /**
   * Frame Earth plus its whole orbital region (LEO to just past GEO). This is
   * the framing used by the orbital-traffic mode, where the point is to read
   * the population of cataloged objects rather than the planet surface.
   */
  frameOrbitalRegion(kmSpan = 45_000): void {
    this.scaleMode = 'focus';
    this.focusBody = 'Earth';
    this.updateForDate(this.simDate);
    this.camTarget.set(0, 0, 0);
    this.camTargetGoal.set(0, 0, 0);
    const spanUnits = kmSpan * this.kmPerUnit;
    const vFov = (this.camera.fov * Math.PI) / 360;
    const hFov = Math.atan(Math.tan(vFov) * Math.max(0.4, this.camera.aspect));
    this.camDistGoal = (spanUnits / Math.sin(Math.min(vFov, hFov))) * 1.08;
    this.clampDistances();
    this.flying = true;
    this.emitCameraInfo();
  }

  /** Back to the whole-system overview. */
  flyToOverview(): void {
    this.scaleMode = 'overview';
    this.focusBody = null;
    this.resetMoonOrbitScale();
    this.updateForDate(this.simDate);
    this.camTargetGoal.set(0, 0, 0);
    this.camPhiGoal = 1.0;
    this.frameOverview();
    this.flying = true;
    this.emitCameraInfo();
  }

  /**
   * Fit every body of the overview into the viewport. The camera distance is
   * derived from the largest body radius in overview scene units and the
   * vertical/horizontal field of view, so it stays correct at any window size.
   */
  frameOverview(): void {
    let maxR = 0;
    for (const name of BODY_ORDER) {
      const g = this.bodyGroups.get(name);
      if (!g) continue;
      maxR = Math.max(maxR, g.position.length() + overviewVisualRadius(name));
    }
    if (maxR <= 0) maxR = 254;
    const vFov = (this.camera.fov * Math.PI) / 360;
    const aspect = Math.max(0.4, this.camera.aspect);
    const hFov = Math.atan(Math.tan(vFov) * aspect);
    const half = Math.min(vFov, hFov);
    const dist = (maxR / Math.sin(half)) * 1.08;
    this.minDist = 30;
    this.maxDist = maxR * 3.2;
    this.camDistGoal = THREE.MathUtils.clamp(dist, this.minDist, this.maxDist);
    this.camDist = this.camDistGoal;
    this.emitCameraInfo();
  }

  flyToSatellite(obj: CatalogObject): void {
    const st = this.catalogStates.find((s) => s.noradId === obj.noradId);
    if (!st) return;
    const eci = temeToEci(new THREE.Vector3(st.position.x, st.position.y, st.position.z), this.gmstRad);
    const earthHelio = this.helio.get('Earth') ?? new THREE.Vector3();
    const scene = this.mapEarthOrbit(eci, earthHelio);
    this.scaleMode = 'focus';
    this.focusBody = 'Earth';
    this.updateForDate(this.simDate);
    this.camTargetGoal.copy(scene);
    // Stand off ~9 body radii so the parent planet stays in frame behind the object.
    this.camDistGoal = Math.max(1_200, this.bodyVisualUnits('Earth') * 9);
    this.clampDistances();
    this.flying = true;
    this.selected = `sat:${obj.noradId}`;
    this.emitCameraInfo();
  }

  resetCamera(): void {
    this.flyToOverview();
  }

  private clampDistances(): void {
    if (this.scaleMode === 'overview') {
      this.minDist = 30;
      this.maxDist = 40_000;
      this.camDistGoal = THREE.MathUtils.clamp(this.camDistGoal, this.minDist, this.maxDist);
    } else {
      const body = this.focusBody ?? 'Earth';
      const r = this.bodyVisualUnits(body);
      this.minDist = Math.max(2, r * 1.25);
      this.maxDist = Math.max(60_000, r * 900);
      this.camDistGoal = Math.min(this.maxDist, Math.max(this.minDist, this.camDistGoal));
    }
  }

  private bodyVisualUnits(name: string): number {
    if (this.scaleMode === 'overview') return overviewVisualRadius(name);
    return BODY_INFO[name].radiusKm * this.kmPerUnit;
  }

  private emitCameraInfo(): void {
    const body = this.focusBody;
    const r = body ? (this.helio.get(body)?.length() ?? 1) : 1;
    this.onCameraChange?.({
      scaleMode: this.scaleMode,
      focusBody: body,
      distanceUnits: this.camDist,
      exaggeration:
        this.scaleMode === 'overview'
          ? `bodies enlarged ×${body ? Math.round(exaggerationFactor(body, r)) : '—'} (log-compressed distances)`
          : 'true local scale (1 body radius = 300 units)',
    });
  }

  // ── selection & route overlays ─────────────────────────────────────────────

  select(name: string | null): void {
    this.selected = name;
  }

  clearRoute(): void {
    for (const l of this.routeLines) {
      this.routeGroup.remove(l);
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    this.routeLines = [];
    for (const m of this.waypointMarkers) {
      this.waypointGroup.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.waypointMarkers = [];
    if (this.exploredPoints) {
      this.scene.remove(this.exploredPoints);
      this.exploredPoints.geometry.dispose();
      this.exploredPoints = null;
    }
  }

  /**
   * Draw a route. `pathKm` are Earth-centred or heliocentric kilometres as
   * produced by the mission graph; `frame` says which.
   */
  drawRoute(pathKm: THREE.Vector3[], exploredKm: THREE.Vector3[], frame: 'earth' | 'helio', label?: string): void {
    this.clearRoute();
    if (pathKm.length < 2) return;
    const earthHelio = this.helio.get('Earth') ?? new THREE.Vector3();
    const toScene = (p: THREE.Vector3) => {
      if (this.scaleMode === 'overview') {
        const helio = frame === 'earth' ? p.clone().add(earthHelio) : p;
        const r = helio.length();
        return helio.multiplyScalar(overviewRadial(r) / Math.max(1e-9, r));
      }
      const local = frame === 'earth' ? p.clone().multiplyScalar(this.kmPerUnit) : focusPosition(p, this.focusOriginKm, this.kmPerUnit);
      return local;
    };
    const pts = pathKm.map(toScene);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: COLORS.route, transparent: true, opacity: 0.95 }),
    );
    this.routeLines.push(line);
    this.routeGroup.add(line);

    pts.forEach((p, i) => {
      const isStart = i === 0;
      const isEnd = i === pts.length - 1;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(1.2, this.bodyVisualUnits(this.focusBody ?? 'Earth') * 0.05), 10, 8),
        new THREE.MeshBasicMaterial({ color: isStart ? COLORS.origin : isEnd ? COLORS.destination : COLORS.route }),
      );
      m.position.copy(p);
      this.waypointMarkers.push(m);
      this.waypointGroup.add(m);
    });
    void label;

    if (exploredKm.length > 0) {
      const arr: number[] = [];
      for (const p of exploredKm) {
        const s = toScene(p);
        arr.push(s.x, s.y, s.z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      this.exploredPoints = new THREE.Points(
        g,
        new THREE.PointsMaterial({ color: COLORS.explored, size: 4, transparent: true, opacity: 0.5, depthWrite: false }),
      );
      this.scene.add(this.exploredPoints);
    }
  }

  /**
   * Draw the D* Lite route as a polyline through occupancy-cell centres.
   * Cell centres are Earth-centred km in the same frame as the SGP4 output.
   */
  drawCellPath(cells: [number, number, number][]): void {
    this.clearRoute();
    if (cells.length < 2) return;
    const grid: { altBands: number; azSectors: number; polarSectors: number } = {
      altBands: 9,
      azSectors: 20,
      polarSectors: 7,
    };
    const pts = cells.map((c) => {
      const v = cellCentre(grid as never, c[0], c[1], c[2]);
      return new THREE.Vector3(v.x, v.y, v.z);
    });
    // Reuse drawRoute with the Earth-centred frame.
    this.drawRoute(pts, [], 'earth', 'D* Lite route');
  }

  markOrigin(km: THREE.Vector3): void {
    this.positionHalo(this.originMarker, km);
  }

  markDestination(km: THREE.Vector3): void {
    this.positionHalo(this.destinationMarker, km);
  }

  private positionHalo(halo: THREE.Mesh, km: THREE.Vector3): void {
    const earthHelio = this.helio.get('Earth') ?? new THREE.Vector3();
    const scene =
      this.scaleMode === 'overview'
        ? (() => {
            const helio = km.clone().add(earthHelio);
            const r = helio.length();
            return helio.multiplyScalar(overviewRadial(r) / Math.max(1e-9, r));
          })()
        : km.clone().multiplyScalar(this.kmPerUnit);
    const size = Math.max(4, this.bodyVisualUnits(this.focusBody ?? 'Earth') * 0.35);
    halo.position.copy(scene);
    halo.scale.set(size, size, size);
    halo.visible = true;
  }

  // ── picking ────────────────────────────────────────────────────────────────

  private pick(cx: number, cy: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((cx - rect.left) / rect.width) * 2 - 1,
      -((cy - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    this.raycaster.params.Points = { threshold: 8 };
    const bodyHits = this.raycaster.intersectObjects([...this.bodyMeshes.values()], false);
    if (bodyHits.length > 0) {
      const name = bodyHits[0].object.userData.bodyName as string;
      this.handleBodyHit(name);
      return;
    }
    if (this.satPoints) {
      const hits = this.raycaster.intersectObject(this.satPoints, false);
      if (hits.length > 0 && hits[0].index !== undefined) {
        const idx = hits[0].index;
        const obj = this.visibleList[idx];
        if (obj) {
          if (this.clickMode === 'set_destination') {
            const st = this.catalogStates.find((s) => s.noradId === obj.noradId);
            if (st) this.onPickDestination?.(obj.name, 'satellite', new THREE.Vector3(st.position.x, st.position.y, st.position.z));
            return;
          }
          const st = this.catalogStates.find((s) => s.noradId === obj.noradId) ?? null;
          this.onSelectSatellite?.(obj, st);
          return;
        }
      }
    }
    if (this.clickMode !== 'inspect') return;
    this.onSelectBody?.(this.selected ?? '');
  }

  private handleBodyHit(name: string): void {
    const mesh = this.bodyMeshes.get(name);
    if (!mesh) return;
    if (this.clickMode === 'set_origin' && name === 'Earth') {
      const local = this.raycaster.ray.intersectSphere(new THREE.Sphere(this.bodyGroups.get('Earth')!.position, overviewVisualRadius('Earth')), new THREE.Vector3());
      if (local) {
        const v = local.clone().sub(this.bodyGroups.get('Earth')!.position).normalize();
        const lat = Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)) * (180 / Math.PI);
        const lon = Math.atan2(v.z, v.x) * (180 / Math.PI);
        this.onPickOrigin?.(lat, lon, `Earth surface ${lat.toFixed(1)}°, ${lon.toFixed(1)}°`);
      }
      return;
    }
    if (this.clickMode === 'set_destination') {
      const h = this.helio.get(name);
      if (h) this.onPickDestination?.(name, 'body', h.clone());
      return;
    }
    this.selected = name;
    this.onSelectBody?.(name);
  }

  private bindInput(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.pointerDown = true;
      this.pointerButton = e.button;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.downPointer = { x: e.clientX, y: e.clientY };
      this.movedDistance = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.movedDistance += Math.abs(dx) + Math.abs(dy);
      if (this.pointerButton === 0 && !e.shiftKey) {
        this.camThetaGoal -= dx * 0.005;
        this.camPhiGoal = THREE.MathUtils.clamp(this.camPhiGoal - dy * 0.005, 0.08, Math.PI - 0.08);
        this.camTheta = this.camThetaGoal;
        this.camPhi = this.camPhiGoal;
      } else {
        const speed = this.camDist * 0.0016;
        const fwd = new THREE.Vector3();
        this.camera.getWorldDirection(fwd);
        const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
        this.camTargetGoal.addScaledVector(right, -dx * speed);
        this.camTargetGoal.addScaledVector(up, dy * speed);
        this.camTarget.copy(this.camTargetGoal);
      }
    });
    const finish = (e: PointerEvent) => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      if (this.movedDistance < 6) this.pick(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', () => { this.pointerDown = false; });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        this.camDistGoal = THREE.MathUtils.clamp(this.camDistGoal * f, this.minDist, this.maxDist);
        this.camDist = this.camDistGoal;
      },
      { passive: false },
    );
    el.addEventListener('dblclick', (e) => {
      const rect = el.getBoundingClientRect();
      this.pointerNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hits = this.raycaster.intersectObjects([...this.bodyMeshes.values()], false);
      if (hits.length > 0) this.flyToBody(hits[0].object.userData.bodyName as string);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * A throttled tab resumes with a huge catch-up animation; stepping the loop
   * keeps the transition readable when the user comes back.
   */
  private onVisibility = (): void => {
    if (document.hidden) return;
    this.step(30);
  };

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  // ── labels ─────────────────────────────────────────────────────────────────

  private computeLabels(): SceneLabel[] {
    const vw = this.container.clientWidth;
    const vh = this.container.clientHeight;
    const out: SceneLabel[] = [];
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const toCam = this.camera.position.clone().sub(this.camTarget).normalize();
    void camDir;
    void toCam;

    const candidates: { name: string; x: number; y: number; r: number; dist: number; kind: SceneLabel['kind'] }[] = [];
    for (const name of BODY_ORDER) {
      const group = this.bodyGroups.get(name);
      if (!group) continue;
      const world = group.position;
      const distToCam = world.distanceTo(this.camera.position);
      const rUnits = this.bodyVisualUnits(name);
      const rPx = (rUnits / Math.max(0.001, distToCam)) * (vh / (2 * Math.tan((this.camera.fov * Math.PI) / 360)));
      const ndc = world.clone().project(this.camera);
      if (ndc.z > 1 || ndc.z < -1) continue;
      const sx = (ndc.x * 0.5 + 0.5) * vw;
      const sy = (ndc.y * -0.5 + 0.5) * vh;
      if (sx < -80 || sx > vw + 80 || sy < -40 || sy > vh + 40) continue;
      // The label itself must fit on screen once it is placed.
      if (sy - 24 < 0 || sy + 24 > vh) continue;
      // In focus mode most bodies are sub-pixel specks; only label the things
      // the viewer can actually act on (the focus, its moons, the selection).
      const isRelevant =
        this.selected === name ||
        (this.focusBody !== null &&
          (name === this.focusBody || BODY_PARENT[name] === this.focusBody));
      if (rPx < 1.6 && !isRelevant) continue;
      if (rPx < 1.6 && this.focusBody !== null && name !== this.focusBody && BODY_PARENT[name] !== this.focusBody) continue;
      candidates.push({ name, x: sx, y: sy, r: rPx, dist: distToCam, kind: BODY_INFO[name].kind });
    }

    // Priority: selected first, then planets, then moons. Bodies closer to the
    // camera win ties so the viewer sees what they are actually looking at.
    const rank = (c: { name: string; kind: string; dist: number }) => {
      let s = 0;
      if (this.selected === c.name) s -= 1000;
      if (c.kind === 'planet') s -= 100;
      if (c.kind === 'star') s -= 200;
      s += Math.min(500, c.dist / 1000);
      return s;
    };
    candidates.sort((a, b) => rank(a) - rank(b));

    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const c of candidates) {
      const text = c.name.toUpperCase();
      const labelW = this.measureLabel(text);
      const labelH = 20;
      // Try directly above/below the body first, then to the sides, then
      // progressively further out. This keeps moon clusters readable without
      // ever letting two labels share a rectangle.
      const offsets: [number, number][] = [];
      for (const far of [1, 1.8, 2.8]) {
        offsets.push([0, -c.r - 14 * far], [0, c.r + 16 * far]);
        offsets.push([(labelW / 2 + 10) * far, 0], [(-labelW / 2 - 10) * far, 0]);
        offsets.push([(labelW / 2 + 10) * far, -c.r - 10 * far], [(-labelW / 2 - 10) * far, -c.r - 10 * far]);
      }
      let chosen: [number, number] | null = null;
      for (const [ox, oy] of offsets) {
        const x = c.x + ox;
        const y = c.y + oy;
        const box = { x: x - labelW / 2, y: y - labelH / 2, w: labelW, h: labelH };
        if (box.x < 0 || box.y < 0 || box.x + box.w > vw || box.y + box.h > vh) continue;
        const clash = placed.some(
          (p) => box.x < p.x + p.w && p.x < box.x + box.w && box.y < p.y + p.h && p.y < box.y + box.h,
        );
        if (!clash) {
          chosen = [x, y];
          placed.push({ x: box.x, y: box.y, w: box.w, h: labelH });
          break;
        }
      }
      if (!chosen) continue;
      const h = this.helio.get(c.name);
      out.push({
        name: c.name,
        screenX: Math.round(chosen[0]),
        screenY: Math.round(chosen[1]),
        kind: c.kind,
        distanceKm: h ? h.length() : undefined,
        selected: this.selected === c.name,
      });
    }
    return out;
  }

  // ── render loop ────────────────────────────────────────────────────────────

  /**
   * Run `frames` iterations of the render loop immediately. Used by the
   * automated checks (and after a tab becomes visible again) so a fly-to
   * converges even when requestAnimationFrame is throttled.
   */
  step(frames = 1): void {
    for (let i = 0; i < frames; i++) this.renderFrame();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    this.renderFrame();
  };

  private renderFrame(): void {
    // Damped camera.
    this.camDist += (this.camDistGoal - this.camDist) * 0.16;
    this.camTheta += (this.camThetaGoal - this.camTheta) * 0.18;
    this.camPhi += (this.camPhiGoal - this.camPhi) * 0.18;
    this.camTarget.lerp(this.camTargetGoal, 0.16);
    this.applyCamera();

    // Gentle axial rotation for planets (visual only).
    for (const [name, mesh] of this.bodyMeshes) {
      const rate = ROTATION_RATE[name];
      if (rate) mesh.rotation.y += rate;
    }

    // Selection halo faces the camera.
    if (this.selected && this.bodyGroups.has(this.selected)) {
      const g = this.bodyGroups.get(this.selected)!;
      const r = this.bodyVisualUnits(this.selected) * 1.45;
      this.selectionHalo.position.copy(g.position);
      this.selectionHalo.scale.set(r, r, r);
      this.selectionHalo.quaternion.copy(this.camera.quaternion);
      this.selectionHalo.visible = true;
    } else {
      this.selectionHalo.visible = false;
    }
    this.originMarker.quaternion.copy(this.camera.quaternion);
    this.destinationMarker.quaternion.copy(this.camera.quaternion);

    // Highlight the selected catalog object.
    if (this.selected?.startsWith('sat:') && this.satPoints) {
      const id = Number(this.selected.slice(4));
      const list = this.visibleList;
      const idx = list.findIndex((o) => o.noradId === id);
      const attr = this.satPoints.geometry.attributes.position as THREE.BufferAttribute;
      if (idx >= 0 && idx < attr.count) {
        const p = new THREE.Vector3().fromBufferAttribute(attr, idx);
        const size = Math.max(8, this.bodyVisualUnits(this.focusBody ?? 'Earth') * 0.16);
        this.satHalo.position.copy(p);
        this.satHalo.scale.set(size, size, size);
        this.satHalo.quaternion.copy(this.camera.quaternion);
        this.satHalo.visible = true;
      } else {
        this.satHalo.visible = false;
      }
    } else {
      this.satHalo.visible = false;
    }

    this.renderer.render(this.scene, this.camera);
    this.applyBodyVisibility();

    // Publish labels at ~12 Hz, not every frame.
    if (this.frame % 5 === 0) {
      this.labelThrottle++;
      if (this.labelThrottle % 2 === 0) this.onLabels?.(this.computeLabels());
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.renderer.dispose();
    if (this.container.contains(this.renderer.domElement)) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // ── accessors for the UI ───────────────────────────────────────────────────

  get counts(): { loaded: number; matching: number; rendered: boolean } {
    return {
      loaded: this.catalog.length,
      matching: this.matchingCount,
      rendered: this.satelliteGroup.visible,
    };
  }

  get currentScale(): { mode: ScaleMode; focus: string | null } {
    return { mode: this.scaleMode, focus: this.focusBody };
  }

  get cameraDistance(): number {
    return this.camDist;
  }

  /** Capture the current frame as a PNG data URL (used by automated checks). */
  capture(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Screen-space positions of every body (used by the audit checks). */
  debugLabelPositions(): Record<string, { x: number; y: number; visible: boolean }> {
    const out: Record<string, { x: number; y: number; visible: boolean }> = {};
    for (const name of BODY_ORDER) {
      const g = this.bodyGroups.get(name);
      if (!g) continue;
      const ndc = g.position.clone().project(this.camera);
      out[name] = {
        x: (ndc.x * 0.5 + 0.5) * this.container.clientWidth,
        y: (-ndc.y * 0.5 + 0.5) * this.container.clientHeight,
        visible: g.visible,
      };
    }
    return out;
  }

  /** Debug: the camera distance the rig is easing towards. */
  debugCamGoal(): { goal: number; min: number; max: number; mode: string; focus: string | null } {
    return { goal: this.camDistGoal, min: this.minDist, max: this.maxDist, mode: this.scaleMode, focus: this.focusBody };
  }

  /** Current TEME positions of the visible catalog objects (audit checks). */
  debugSatellitePositions(limit = 8): { noradId: number; x: number; y: number; z: number }[] {
    const out: { noradId: number; x: number; y: number; z: number }[] = [];
    const list = this.visibleList;
    for (const o of list.slice(0, limit)) {
      const st = this.catalogStates.find((s) => s.noradId === o.noradId);
      if (st) out.push({ noradId: o.noradId, x: st.position.x, y: st.position.y, z: st.position.z });
    }
    return out;
  }

  /** Cached text measurement so label boxes match the rendered CSS size. */
  private labelCtx: CanvasRenderingContext2D | null = null;
  private labelCache = new Map<string, number>();
  private measureLabel(text: string): number {
    if (this.labelCache.has(text)) return this.labelCache.get(text)!;
    if (!this.labelCtx) {
      const c = document.createElement('canvas');
      this.labelCtx = c.getContext('2d');
    }
    let w: number;
    if (this.labelCtx) {
      // Matches .body-label: 10px uppercase, 0.06em tracking, 7px side padding.
      this.labelCtx.font = `700 10px Inter, system-ui, sans-serif`;
      // `.body-label` uses 0.06em letter-spacing, which measureText ignores.
      try { (this.labelCtx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0.06em'; }
      catch { /* older browsers */ }
      w = this.labelCtx.measureText(text).width + 16;
    } else {
      w = text.length * 7.2 + 18;
    }
    this.labelCache.set(text, w);
    return w;
  }

  /** Currently published labels (used by the audit checks). */
  debugLabels(): SceneLabel[] {
    return this.computeLabels();
  }

  /** Surface latitude/longitude of a client point on Earth, or null. */
  latLonFromClient(cx: number, cy: number): { lat: number; lon: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((cx - rect.left) / rect.width) * 2 - 1,
      -((cy - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const earth = this.bodyGroups.get('Earth');
    if (!earth) return null;
    const hit = this.raycaster.ray.intersectSphere(
      new THREE.Sphere(earth.position, overviewVisualRadius('Earth')),
      new THREE.Vector3(),
    );
    if (!hit) return null;
    const v = hit.clone().sub(earth.position).normalize();
    return {
      lat: Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)) * (180 / Math.PI),
      lon: Math.atan2(v.z, v.x) * (180 / Math.PI),
    };
  }

  /** Earth-centred inertial position of a lat/lon at the current GMST, km. */
  static eciForLatLon(lat: number, lon: number, gmstRad: number): THREE.Vector3 {
    const r = EARTH_RADIUS_KM;
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    const ecef = new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), r * Math.cos(la) * Math.sin(lo));
    return temeToEci(ecef, gmstRad);
  }
}

const BODY_COLOR: Record<string, number> = {
  Sun: 0xffd166,
  Mercury: 0x9aa3ad,
  Venus: 0xe6c88a,
  Earth: 0x3b82c4,
  Moon: 0xbfc5cc,
  Mars: 0xc1502e,
  Jupiter: 0xd9b07c,
  Saturn: 0xe3cf9a,
  Uranus: 0x86dcdc,
  Neptune: 0x4b6ddb,
  Io: 0xe0d27a,
  Europa: 0xd8cfc0,
  Ganymede: 0xb9ada0,
  Callisto: 0x9a9086,
  Titan: 0xd8a860,
};

const BODY_ORBIT_COLOR: Record<string, number> = {
  Mercury: 0x5b6472,
  Venus: 0x6b5c33,
  Earth: 0x27527f,
  Mars: 0x6e3524,
  Jupiter: 0x6a5324,
  Saturn: 0x6b5a2c,
  Uranus: 0x1f5f74,
  Neptune: 0x24357e,
};

/** Radians per frame of axial spin — decorative only. */
const ROTATION_RATE: Record<string, number> = {
  Earth: 0.0016,
  Jupiter: 0.003,
  Saturn: 0.0026,
  Mars: 0.0016,
  Venus: 0.0004,
  Mercury: 0.0004,
  Moon: 0.0008,
};

export { BODY_COLOR };
