import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

import { Change, GraphNode, Op, Ring, StepKind, SystemGraph } from "@hexvis/core";

import { HexagonLayout, hexagonCorners } from "./hexagon-layout";

const RING_COLOR: Record<Ring, number> = {
  [Ring.Edge]: 0x8a8f98,
  [Ring.InboundAdapter]: 0x3b82f6,
  [Ring.Core]: 0x10b981,
  [Ring.OutboundAdapter]: 0xf59e0b,
  [Ring.TestDouble]: 0xa1a1aa,
  [Ring.External]: 0xa855f7,
};
const CALL_COLOR = 0x5eead4;
const VIOLATION_COLOR = 0xe5534b;
const ADDED_COLOR = 0x10b981;
const REMOVED_COLOR = 0xe5534b;
const CHANGED_COLOR = 0xf59e0b;
// Above 1.0 so only the packets cross the bloom threshold and glow.
const PULSE_BRIGHTNESS = 3;
const PULSE_MS = 450;
const TRAIL_POINTS = 14;
const TRAIL_LENGTH = 0.12;
const TILE_HEIGHT = 1.2;
const OBJECT_SIDE = 1.6;
const MAX_OBJECTS_SHOWN = 16;
const DIMMED_OPACITY = 0.08;
const CLICK_TOLERANCE_PX = 4;

export type Emphasis = "normal" | "highlighted" | "dimmed";

interface TileParts {
  node: GraphNode;
  body: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  outline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  objects: THREE.InstancedMesh | null;
  label: CSS2DObject;
}

interface ArcParts {
  curve: THREE.QuadraticBezierCurve3;
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  baseColor: number;
}

interface Packet {
  curve: THREE.QuadraticBezierCurve3;
  reverse: boolean;
  started: number;
  head: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  trail: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}

/**
 * The 3D view: components as tiles on a hexagon floor, their live objects as cubes above
 * them, calls as arcs, and replay steps as packets of light travelling the arcs. Imperative
 * three.js state lives here; the React wrapper (Scene3D) only forwards changes.
 */
export class HexScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 5000);
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly world = new THREE.Group();
  private readonly tiles = new Map<string, TileParts>();
  private readonly arcs = new Map<string, ArcParts>();
  private readonly packets: Packet[] = [];
  private readonly resize: ResizeObserver;
  private frame = 0;
  private pointerDown: { x: number; y: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly onPick: (node: GraphNode) => void,
    background: string,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(new THREE.Color(background));
    container.appendChild(this.renderer.domElement);

    // Labels are HTML over the canvas; the overlay takes the mouse so orbiting works
    // everywhere, and each label opts back in to clicks.
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "scene-labels";
    container.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.Fog(new THREE.Color(background), 400, 1600);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(80, 160, 60);
    this.scene.add(sun, this.world);

    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49; // stay above the floor

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.5, 0.85));
    this.composer.addPass(new OutputPass());

    this.labels.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.labels.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.resize = new ResizeObserver(() => this.fitToContainer());
    this.resize.observe(container);
    this.fitToContainer();
    this.frame = requestAnimationFrame(this.animate);
  }

  setGraph(graph: SystemGraph, layout: HexagonLayout): void {
    this.clearWorld();
    this.addFloor(layout.radius);
    for (const node of graph.nodes) {
      const tile = layout.tiles.get(node.id);
      if (tile) this.addTile(node, tile.x, tile.z, tile.size);
    }
    for (const edge of graph.edges) {
      const from = this.tiles.get(edge.from);
      const to = this.tiles.get(edge.to);
      if (!from || !to) continue;
      const start = from.body.position.clone().setY(TILE_HEIGHT);
      const end = to.body.position.clone().setY(TILE_HEIGHT);
      const lift = 6 + start.distanceTo(end) * 0.22;
      const control = start.clone().lerp(end, 0.5).setY(lift);
      const curve = new THREE.QuadraticBezierCurve3(start, control, end);
      const radius = 0.12 + Math.log2(edge.calls + 1) * 0.07;
      const baseColor = edge.violation ? VIOLATION_COLOR : CALL_COLOR;
      const material = new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.45, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 6, false), material);
      this.world.add(mesh);
      this.arcs.set(edge.id, { curve, mesh, baseColor });
    }
    this.frameCamera();
  }

  /** Who is lit: the selected scenario's path, the replay's current hop, compare-mode changes. */
  setEmphasis(
    nodeEmphasis: (node: GraphNode) => Emphasis,
    edgeEmphasis: (edgeId: string) => Emphasis,
    activeNodes: Set<string>,
    nodeChanges: Map<string, Change> | null,
    edgeChanges: Map<string, Change> | null,
  ): void {
    for (const [id, tile] of this.tiles) {
      const emphasis = nodeEmphasis(tile.node);
      const active = activeNodes.has(id);
      const change = nodeChanges?.get(id) ?? null;
      tile.body.material.opacity = emphasis === "dimmed" ? DIMMED_OPACITY : 0.55;
      tile.body.material.emissiveIntensity = active ? 1.2 : 0.25;
      tile.outline.material.color.setHex(changeColor(change) ?? (tile.node.smells.length ? CHANGED_COLOR : RING_COLOR[tile.node.ring]));
      tile.outline.material.opacity = emphasis === "dimmed" ? 0.2 : 1;
      if (tile.objects) (tile.objects.material as THREE.MeshStandardMaterial).opacity = emphasis === "dimmed" ? DIMMED_OPACITY : 0.9;
      tile.label.element.style.opacity = emphasis === "dimmed" ? "0.3" : "1";
      tile.label.element.classList.toggle("active", active);
    }
    for (const [id, arc] of this.arcs) {
      const emphasis = edgeEmphasis(id);
      arc.mesh.material.color.setHex(changeColor(edgeChanges?.get(id) ?? null) ?? arc.baseColor);
      arc.mesh.material.opacity = emphasis === "dimmed" ? 0.05 : emphasis === "highlighted" ? 0.8 : 0.45;
    }
  }

  /** Send a packet of light along a call's arc (backwards for a return). */
  pulse(edgeId: string, kind: StepKind, op: Op | null): void {
    const arc = this.arcs.get(edgeId);
    if (!arc) return;
    const color = new THREE.Color(op === Op.Added ? ADDED_COLOR : op === Op.Removed ? REMOVED_COLOR : kind === StepKind.External ? 0xc084fc : 0xfde047);
    const bright = color.clone().multiplyScalar(PULSE_BRIGHTNESS);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 12), new THREE.MeshBasicMaterial({ color: bright }));
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
    const fade = new Float32Array(TRAIL_POINTS * 3);
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      const strength = (1 - i / TRAIL_POINTS) ** 1.6;
      fade.set([bright.r * strength, bright.g * strength, bright.b * strength], i * 3);
    }
    trailGeometry.setAttribute("color", new THREE.Float32BufferAttribute(fade, 3));
    const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }));
    this.world.add(head, trail);
    this.packets.push({ curve: arc.curve, reverse: kind === StepKind.Return, started: performance.now(), head, trail });
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.labels.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.labels.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.clearWorld();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private addFloor(radius: number): void {
    const corners = hexagonCorners(radius);
    const shape = new THREE.Shape(corners.map(([x, z]) => new THREE.Vector2(x, -z)));
    const floor = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: RING_COLOR[Ring.Core], transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    const rim = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, 0.05, z))),
      new THREE.LineBasicMaterial({ color: RING_COLOR[Ring.Core], transparent: true, opacity: 0.6 }),
    );
    const grid = new THREE.PolarGridHelper(radius * 2.6, 6, 8, 64, 0x2a3240, 0x1d232c);
    grid.position.y = -0.05;
    this.world.add(grid, floor, rim);
  }

  private addTile(node: GraphNode, x: number, z: number, size: number): void {
    const color = RING_COLOR[node.ring];
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(size, TILE_HEIGHT, size),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, transparent: true, opacity: 0.55, roughness: 0.6 }),
    );
    body.position.set(x, TILE_HEIGHT / 2, z);
    body.userData.nodeId = node.id;
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color, transparent: true }));
    outline.position.copy(body.position);

    // A class's live objects float above it: the tile is the definition, cubes its instances.
    let objects: THREE.InstancedMesh | null = null;
    const count = Math.min(node.instances, MAX_OBJECTS_SHOWN);
    if (count > 0) {
      objects = new THREE.InstancedMesh(
        new THREE.BoxGeometry(OBJECT_SIDE, OBJECT_SIDE, OBJECT_SIDE),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, transparent: true, opacity: 0.9 }),
        count,
      );
      const perRow = Math.ceil(Math.sqrt(count));
      const step = OBJECT_SIDE * 1.5;
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < count; i += 1) {
        const row = Math.floor(i / perRow);
        const column = i % perRow;
        matrix.setPosition(x + (column - (perRow - 1) / 2) * step, 5 + (i % 3) * 0.6, z + (row - (perRow - 1) / 2) * step);
        objects.setMatrixAt(i, matrix);
      }
      this.world.add(objects);
    }

    const element = document.createElement("button");
    element.type = "button";
    element.className = `label3d ring-${node.ring}`;
    element.textContent = node.label;
    element.title = `${node.qualifiedName ?? node.label}\n${node.ring}: ${node.ringReason}`;
    element.addEventListener("click", () => this.onPick(node));
    const label = new CSS2DObject(element);
    label.position.set(x, count > 0 ? 9 : 3.2, z);
    this.world.add(body, outline, label);
    this.tiles.set(node.id, { node, body, outline, objects, label });
  }

  /** Fit everything, from the client on the far left to the external systems on the right. */
  private frameCamera(): void {
    const bounds = new THREE.Box3();
    for (const tile of this.tiles.values()) bounds.expandByObject(tile.body);
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const distance = (sphere.radius / Math.sin(halfFov)) * 0.7;
    const fromFrontAbove = new THREE.Vector3(-0.15, 0.85, 0.9).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(fromFrontAbove, distance);
    this.controls.target.copy(sphere.center);
    this.controls.update();
  }

  private clearWorld(): void {
    for (const packet of this.packets.splice(0)) this.disposeObject(packet.head, packet.trail);
    for (const tile of this.tiles.values()) tile.label.element.remove();
    // Descendants only: traverse() also visits the world group itself, and disposing that
    // would detach it from the scene.
    for (const child of [...this.world.children]) child.traverse((object) => this.disposeObject(object));
    this.world.clear();
    this.tiles.clear();
    this.arcs.clear();
  }

  private disposeObject(...objects: THREE.Object3D[]): void {
    for (const object of objects) {
      const disposable = object as Partial<THREE.Mesh>;
      disposable.geometry?.dispose();
      const material = disposable.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
      object.removeFromParent();
    }
  }

  private fitToContainer(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.labels.setSize(width, height);
    this.composer.setSize(width, height);
  }

  private readonly animate = (now: number): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    this.advancePackets(now);
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  };

  private advancePackets(now: number): void {
    for (let i = this.packets.length - 1; i >= 0; i -= 1) {
      const packet = this.packets[i]!;
      const progress = (now - packet.started) / PULSE_MS;
      if (progress >= 1) {
        this.disposeObject(packet.head, packet.trail);
        this.packets.splice(i, 1);
        continue;
      }
      const at = (t: number) => packet.curve.getPointAt(Math.min(1, Math.max(0, packet.reverse ? 1 - t : t)));
      packet.head.position.copy(at(progress));
      const positions = packet.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let p = 0; p < TRAIL_POINTS; p += 1) {
        const point = at(progress - (TRAIL_LENGTH * p) / TRAIL_POINTS);
        positions.setXYZ(p, point.x, point.y, point.z);
      }
      positions.needsUpdate = true;
    }
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY };
  };

  /** A click (not the end of an orbit drag) on a tile opens that component. */
  private readonly handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hit = raycaster.intersectObjects([...this.tiles.values()].map((tile) => tile.body))[0];
    const id = hit?.object.userData.nodeId as string | undefined;
    const tile = id ? this.tiles.get(id) : undefined;
    if (tile) this.onPick(tile.node);
  };
}

function changeColor(change: Change | null): number | null {
  if (change === Change.Added) return ADDED_COLOR;
  if (change === Change.Removed) return REMOVED_COLOR;
  if (change === Change.Changed) return CHANGED_COLOR;
  return null;
}
