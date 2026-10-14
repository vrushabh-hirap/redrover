import * as THREE from 'three';
import { TerrainData, GridCoord } from '../core/types';

export class TerrainScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  private canvasContainer: HTMLElement;

  // Meshes
  private terrainMesh: THREE.Mesh | null = null;
  private pathLine: THREE.Line | null = null;
  private exploredPoints: THREE.Points | null = null;
  private roverGroup: THREE.Group = new THREE.Group();
  private startMarker: THREE.Mesh | null = null;
  private goalMarker: THREE.Mesh | null = null;

  // Camera Orbit State
  private isPointerDown = false;
  private pointerButton = 0; // 0 = left/orbit, 2 = right/pan
  private previousPointerPosition = { x: 0, y: 0 };
  private spherical = new THREE.Spherical(70, Math.PI / 3.5, Math.PI / 4);
  private targetLookAt = new THREE.Vector3(0, 0, 0);

  private terrain: TerrainData;
  private animationFrameId: number | null = null;

  constructor(container: HTMLElement, terrain: TerrainData) {
    this.canvasContainer = container;
    this.terrain = terrain;

    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0709); // Martian dusk/dark sky
    this.scene.fog = new THREE.FogExp2(0x190d0f, 0.007);

    // 2. Camera setup
    const aspect = container.clientWidth / (container.clientHeight || 1);
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 1000);
    this.updateCameraTransform();

    // 3. Renderer setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // 4. Lights
    this.setupLighting();

    // 5. Build meshes
    this.buildTerrainMesh();
    this.buildRoverModel();
    this.scene.add(this.roverGroup);

    // 6. User interactions
    this.initControls();

    // 7. Start render loop
    this.animate = this.animate.bind(this);
    this.animate();

    window.addEventListener('resize', this.onWindowResize);
  }

  private setupLighting(): void {
    // Ambient Martian reddish light
    const ambientLight = new THREE.AmbientLight(0xffb896, 0.55);
    this.scene.add(ambientLight);

    // Distant Martian sun (warmer golden-red directional light)
    const sunLight = new THREE.DirectionalLight(0xfff0dd, 1.8);
    sunLight.position.set(40, 80, 50);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 250;
    const d = 60;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.0005;
    this.scene.add(sunLight);

    // Subtle rim backlight for atmospheric glow
    const rimLight = new THREE.DirectionalLight(0x406080, 0.35);
    rimLight.position.set(-50, 20, -50);
    this.scene.add(rimLight);
  }

  /**
   * Convert grid (x, y) to world (worldX, elevation, worldZ) centered around (0,0)
   */
  public gridToWorld(gx: number, gy: number): THREE.Vector3 {
    const halfW = (this.terrain.width * this.terrain.resolution) / 2;
    const halfH = (this.terrain.height * this.terrain.resolution) / 2;
    const worldX = gx * this.terrain.resolution - halfW;
    const worldZ = gy * this.terrain.resolution - halfH;

    const clampedY = Math.max(0, Math.min(this.terrain.height - 1, Math.round(gy)));
    const clampedX = Math.max(0, Math.min(this.terrain.width - 1, Math.round(gx)));
    const elev = this.terrain.cells[clampedY][clampedX].elevation;

    return new THREE.Vector3(worldX, elev, worldZ);
  }

  private buildTerrainMesh(): void {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }

    const { width, height, resolution, cells } = this.terrain;
    const geom = new THREE.PlaneGeometry(
      (width - 1) * resolution,
      (height - 1) * resolution,
      width - 1,
      height - 1
    );
    // Rotate plane so X is East/West, Z is North/South, Y is Elevation
    geom.rotateX(-Math.PI / 2);

    const posAttr = geom.attributes.position;
    const colorAttr = new Float32Array(posAttr.count * 3);

    // Mars color palette
    const colorLow = new THREE.Color(0x8c3b24);    // Rust orange-red
    const colorHigh = new THREE.Color(0xd97543);   // Lighter orange ridge
    const colorHazard = new THREE.Color(0x2a1618); // Dark rocky basalt hazard
    const colorDune = new THREE.Color(0xb8502f);

    const { minElevation, maxElevation } = this.terrain;
    const elevRange = Math.max(1, maxElevation - minElevation);

    let vIdx = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = cells[y][x];
        posAttr.setY(vIdx, cell.elevation);

        const tempColor = new THREE.Color();
        const normElev = (cell.elevation - minElevation) / elevRange;

        if (cell.isHazard) {
          tempColor.copy(colorHazard);
        } else if (cell.slope > 14) {
          tempColor.lerpColors(colorLow, colorHazard, 0.45);
        } else {
          tempColor.lerpColors(colorLow, colorHigh, normElev);
          if (cell.roughness > 0.6) {
            tempColor.lerp(colorDune, 0.3);
          }
        }

        colorAttr[vIdx * 3] = tempColor.r;
        colorAttr[vIdx * 3 + 1] = tempColor.g;
        colorAttr[vIdx * 3 + 2] = tempColor.b;

        vIdx++;
      }
    }

    geom.computeVertexNormals();
    geom.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.08,
      flatShading: false,
    });

    this.terrainMesh = new THREE.Mesh(geom, material);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = false;
    this.scene.add(this.terrainMesh);

    // Subtle wireframe grid base
    const gridHelper = new THREE.GridHelper(
      width * resolution,
      width / 4,
      0x4a1e1b,
      0x281214
    );
    gridHelper.position.y = minElevation - 0.2;
    this.scene.add(gridHelper);
  }

  /**
   * Builds an articulated 3D Mars Rover model (chassis, rocker-bogie wheels, mast camera, solar panels)
   */
  private buildRoverModel(): void {
    this.roverGroup.clear();

    // Chassis body
    const bodyGeom = new THREE.BoxGeometry(1.6, 0.7, 2.2);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xe2dfd2, // NASA thermal foil / titanium white
      roughness: 0.4,
      metalness: 0.6,
    });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.y = 0.7;
    body.castShadow = true;
    this.roverGroup.add(body);

    // Solar panels on top
    const panelGeom = new THREE.BoxGeometry(1.8, 0.05, 1.4);
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x112244, // Deep blue photovoltaic cells
      roughness: 0.2,
      metalness: 0.8,
    });
    const panel = new THREE.Mesh(panelGeom, panelMat);
    panel.position.set(0, 1.08, -0.2);
    panel.castShadow = true;
    this.roverGroup.add(panel);

    // Mast & Remote Sensing Mast (Pancam/Mastcam)
    const mastGeom = new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8);
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.8 });
    const mast = new THREE.Mesh(mastGeom, mastMat);
    mast.position.set(0.4, 1.5, 0.7);
    this.roverGroup.add(mast);

    const headGeom = new THREE.BoxGeometry(0.35, 0.2, 0.25);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.3 });
    const head = new THREE.Mesh(headGeom, headMat);
    head.position.set(0.4, 2.15, 0.75);
    this.roverGroup.add(head);

    // Wheels (6 wheels for rocker-bogie suspension)
    const wheelGeom = new THREE.CylinderGeometry(0.32, 0.32, 0.26, 16);
    wheelGeom.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      roughness: 0.9,
      metalness: 0.1,
    });

    const wheelOffsets = [
      [-1.0, 0.32, 0.9],
      [1.0, 0.32, 0.9],
      [-1.05, 0.32, 0.0],
      [1.05, 0.32, 0.0],
      [-1.0, 0.32, -0.9],
      [1.0, 0.32, -0.9],
    ];

    for (const [wx, wy, wz] of wheelOffsets) {
      const wheel = new THREE.Mesh(wheelGeom, wheelMat);
      wheel.position.set(wx, wy, wz);
      wheel.castShadow = true;
      this.roverGroup.add(wheel);
    }

    // Scale rover group to realistic dimensions relative to terrain grid
    this.roverGroup.scale.set(0.9, 0.9, 0.9);
  }

  public setStartAndGoalMarkers(start: GridCoord, goal: GridCoord): void {
    if (this.startMarker) this.scene.remove(this.startMarker);
    if (this.goalMarker) this.scene.remove(this.goalMarker);

    const startPos = this.gridToWorld(start.x, start.y);
    const goalPos = this.gridToWorld(goal.x, goal.y);

    // Green launch pad marker
    const startGeom = new THREE.CylinderGeometry(1.2, 1.2, 0.1, 24);
    const startMat = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.85 });
    this.startMarker = new THREE.Mesh(startGeom, startMat);
    this.startMarker.position.copy(startPos);
    this.startMarker.position.y += 0.05;
    this.scene.add(this.startMarker);

    // Amber goal beacon beacon
    const goalGeom = new THREE.CylinderGeometry(0.1, 1.2, 2.5, 16);
    const goalMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xd97706,
      emissiveIntensity: 0.6,
      roughness: 0.2,
    });
    this.goalMarker = new THREE.Mesh(goalGeom, goalMat);
    this.goalMarker.position.copy(goalPos);
    this.goalMarker.position.y += 1.25;
    this.scene.add(this.goalMarker);
  }

  public updateRoverPose(pos: THREE.Vector3, headingRad: number, pitchRad = 0, rollRad = 0): void {
    this.roverGroup.position.copy(pos);
    // Align rotation: Heading (Y), Pitch (X), Roll (Z)
    this.roverGroup.rotation.set(0, 0, 0);
    this.roverGroup.rotateY(headingRad);
    this.roverGroup.rotateX(pitchRad);
    this.roverGroup.rotateZ(rollRad);
  }

  public drawPath(path: GridCoord[]): void {
    if (this.pathLine) {
      this.scene.remove(this.pathLine);
      this.pathLine.geometry.dispose();
      this.pathLine = null;
    }

    if (path.length < 2) return;

    const points: THREE.Vector3[] = [];
    for (const p of path) {
      const worldPos = this.gridToWorld(p.x, p.y);
      worldPos.y += 0.2; // slightly elevated above ground
      points.push(worldPos);
    }

    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: 0x38bdf8, // Martian cyan route
      linewidth: 3,
    });
    this.pathLine = new THREE.Line(geom, mat);
    this.scene.add(this.pathLine);
  }

  public drawExploredNodes(nodes: GridCoord[]): void {
    if (this.exploredPoints) {
      this.scene.remove(this.exploredPoints);
      this.exploredPoints.geometry.dispose();
      this.exploredPoints = null;
    }

    if (nodes.length === 0) return;

    const vertices: number[] = [];
    for (const n of nodes) {
      const wp = this.gridToWorld(n.x, n.y);
      vertices.push(wp.x, wp.y + 0.08, wp.z);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xf43f5e, // Rose explored frontiers
      size: 0.8,
      transparent: true,
      opacity: 0.65,
    });

    this.exploredPoints = new THREE.Points(geom, mat);
    this.scene.add(this.exploredPoints);
  }

  // Camera Orbit / Pan / Zoom controls
  private initControls(): void {
    const el = this.renderer.domElement;

    el.addEventListener('mousedown', (e) => {
      this.isPointerDown = true;
      this.pointerButton = e.button;
      this.previousPointerPosition = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
      this.isPointerDown = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isPointerDown) return;
      const deltaX = e.clientX - this.previousPointerPosition.x;
      const deltaY = e.clientY - this.previousPointerPosition.y;
      this.previousPointerPosition = { x: e.clientX, y: e.clientY };

      if (this.pointerButton === 0) {
        // Orbit
        this.spherical.theta -= deltaX * 0.008;
        this.spherical.phi -= deltaY * 0.008;
        // Clamp phi to prevent camera flipping
        this.spherical.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, this.spherical.phi));
      } else if (this.pointerButton === 2 || this.pointerButton === 1) {
        // Pan
        const panSpeed = this.spherical.radius * 0.0015;
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        this.targetLookAt.addScaledVector(right, -deltaX * panSpeed);
        this.targetLookAt.addScaledVector(forward, deltaY * panSpeed);
      }
      this.updateCameraTransform();
    });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.spherical.radius += e.deltaY * 0.08;
      this.spherical.radius = Math.max(10, Math.min(220, this.spherical.radius));
      this.updateCameraTransform();
    }, { passive: false });

    // Prevent context menu on right click pan
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  public resetCamera(): void {
    this.spherical.set(70, Math.PI / 3.5, Math.PI / 4);
    this.targetLookAt.set(0, 0, 0);
    this.updateCameraTransform();
  }

  private updateCameraTransform(): void {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.targetLookAt).add(offset);
    this.camera.lookAt(this.targetLookAt);
  }

  private onWindowResize = (): void => {
    if (!this.canvasContainer) return;
    const width = this.canvasContainer.clientWidth;
    const height = this.canvasContainer.clientHeight;
    this.camera.aspect = width / (height || 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private animate(): void {
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
  }

  public dispose(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    window.removeEventListener('resize', this.onWindowResize);
    this.renderer.dispose();
    if (this.canvasContainer.contains(this.renderer.domElement)) {
      this.canvasContainer.removeChild(this.renderer.domElement);
    }
  }
}
