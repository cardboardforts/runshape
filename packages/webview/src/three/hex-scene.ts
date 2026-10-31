import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

import { HEXAGONAL } from "@runshape/architecture";
import { ArchitectureProfile, Change, FloorPiece, FloorTile, GraphNode, Layout, LayoutNode } from "@runshape/kernel";
import { Op, StepKind } from "@runshape/trace";
import { ComponentWiring, ObjectGraph } from "@runshape/visualizer";

import { zoneColor } from "../zone-style";

import { OBJECT_SIDE, objectSlots } from "./object-slots";
import { advanceClock, ClockedObject, popPose } from "./object-clock";
import { chooseVisibleLabels, LabelBox, LabelTier, labelPriority } from "./labels";
import { Point, routeEdges } from "./routes";

const CALL_COLOR = 0x5eead4;
const VIOLATION_COLOR = 0xe5534b;
const ADDED_COLOR = 0x10b981;
const REMOVED_COLOR = 0xe5534b;
const CHANGED_COLOR = 0xf59e0b;
/** A shared floor (the hexagon, the triangle) is tinted like the hexagon's core. */
const CORE_FLOOR_COLOR = 0x10b981;
// Above 1.0 so only the packets cross the bloom threshold and glow.
const PULSE_BRIGHTNESS = 3;
/** Even a pulse for an instant hop stays visible this long. */
const MIN_PULSE_MS = 60;
const TRAIL_POINTS = 14;
const TRAIL_LENGTH = 0.12;
const TILE_HEIGHT = 1.2;
const WIRE_COLOR = 0xc4b5fd;
const WIRE_LIFT = 3;
const DIMMED_OPACITY = 0.08;
const CLICK_TOLERANCE_PX = 4;
/** Below 1 crops the bounding sphere's empty edges; much lower and a triangle's corners fall off screen. */
const FRAMING = 0.8;
/** Re-decide which labels fit every few frames: often enough to follow the camera, cheaply. */
const LABEL_CULL_EVERY_FRAMES = 6;

export type Emphasis = "normal" | "highlighted" | "dimmed";

interface TileParts {
  node: LayoutNode;
  body: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  outline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  label: CSS2DObject;
  layout: FloorTile;
  tier: LabelTier;
  /** Measured once the label has been laid out; until then it is always shown. */
  labelSize: { width: number; height: number } | null;
}

interface ArcParts {
  curve: THREE.Curve<THREE.Vector3>;
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  baseColor: number;
}

interface TrunkParts {
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  edgeIds: string[];
}

interface ObjectInstanceView extends ClockedObject {
  objectId: number;
  mesh: THREE.InstancedMesh;
  index: number;
  /** Where it floats once built, and the tile surface it rises from. */
  slot: THREE.Vector3;
  ground: number;
}

const FOCUS_SCALE = 1.7;
const FOCUS_COLOR = new THREE.Color(0xfde047);
/** Instance colours multiply the material's: white leaves the zone colour as it is. */
const PLAIN_OBJECT = new THREE.Color(0xffffff);

interface Packet {
  curve: THREE.Curve<THREE.Vector3>;
  reverse: boolean;
  started: number;
  durationMs: number;
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
  private readonly bloom: UnrealBloomPass;
  private profile: ArchitectureProfile = HEXAGONAL;
  private readonly world = new THREE.Group();
  private readonly tiles = new Map<string, TileParts>();
  private readonly arcs = new Map<string, ArcParts>();
  private readonly trunks: TrunkParts[] = [];
  /** Live objects and the references between them; rebuilt on its own, without the graph. */
  private readonly objectLayer = new THREE.Group();
  private readonly objectMeshes = new Map<string, THREE.InstancedMesh>();
  private readonly wireLines: { from: string; to: string; atUs: number | null; line: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial> }[] = [];
  /** One per drawn object of the selected scenario: what the replay clock shows, hides and pops. */
  private readonly objectInstances: ObjectInstanceView[] = [];
  /** The replay's current time and the object doing the work; null when not replaying. */
  private clockUs: number | null = null;
  private focusObject: number | null = null;
  private readonly packets: Packet[] = [];
  private readonly resize: ResizeObserver;
  private frame = 0;
  private framesDrawn = 0;
  private pointerDown: { x: number; y: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly onPick: (node: LayoutNode) => void,
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.5, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.labels.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.labels.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.resize = new ResizeObserver(() => this.fitToContainer());
    this.resize.observe(container);
    this.fitToContainer();
    this.frame = requestAnimationFrame(this.animate);
  }

  setLayout(layout: Layout): void {
    this.profile = layout.profile;
    this.clearWorld();
    this.addFloor(layout.floor);
    for (const node of layout.nodes) this.addTile(node, node.floor);
    const { routes, trunks } = routeEdges(layout);
    const edges = new Map(layout.edges.map((edge) => [edge.id, edge]));
    for (const route of routes) {
      const edge = edges.get(route.edgeId)!;
      const curve = new THREE.CatmullRomCurve3(route.points.map(toVector), false, "centripetal");
      // Bundled calls are thin threads along a shared trunk; direct ones carry their own weight.
      const radius = route.trunk ? 0.08 + Math.log2(edge.calls + 1) * 0.02 : 0.12 + Math.log2(edge.calls + 1) * 0.07;
      const baseColor = edge.violation ? VIOLATION_COLOR : CALL_COLOR;
      const material = new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.45, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, route.trunk ? 64 : 40, radius, 6, false), material);
      this.world.add(mesh);
      this.arcs.set(edge.id, { curve, mesh, baseColor });
    }
    for (const trunk of trunks) {
      // The bundle itself: a translucent sheath around the shared stretch, thicker with traffic.
      const curve = new THREE.LineCurve3(toVector(trunk.from), toVector(trunk.to));
      const radius = 0.6 + Math.log2(trunk.calls + 1) * 0.25;
      const material = new THREE.MeshBasicMaterial({ color: CALL_COLOR, transparent: true, opacity: 0.12, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 1, radius, 12, false), material);
      this.world.add(mesh);
      this.trunks.push({ mesh, edgeIds: trunk.edgeIds });
    }
    this.frameCamera();
  }

  /**
   * A class's live objects float above its tile: the tile is the definition, the cubes its
   * instances. Without a test selected, each class shows how many objects it had and a
   * dashed line joins classes whose objects hold one another; with a test selected, every
   * cube is one real object of that test and the lines join the exact objects.
   */
  setObjects(wiring: ComponentWiring[], objects: ObjectGraph | null): void {
    this.clearGroup(this.objectLayer);
    this.objectMeshes.clear();
    this.wireLines.length = 0;
    this.objectInstances.length = 0;

    const slotsByObject = new Map<number, THREE.Vector3>();
    const cloudCentre = new Map<string, THREE.Vector3>();
    for (const [id, tile] of this.tiles) {
      const own = objects ? objects.objects.filter((o) => o.componentId === id) : null;
      const count = own ? own.length : tile.node.instances;
      if (count === 0) continue;
      const slots = objectSlots(tile.layout, count);
      const color = zoneColor(this.profile, tile.node.zone);
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(OBJECT_SIDE, OBJECT_SIDE, OBJECT_SIDE),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, transparent: true, opacity: 0.9 }),
        slots.length,
      );
      const matrix = new THREE.Matrix4();
      const centre = new THREE.Vector3();
      slots.forEach(([x, y, z], index) => {
        mesh.setMatrixAt(index, matrix.makeTranslation(x, y, z));
        centre.add(new THREE.Vector3(x, y, z));
        const object = own?.[index];
        if (object) {
          slotsByObject.set(object.id, new THREE.Vector3(x, y, z));
          this.objectInstances.push({
            objectId: object.id,
            seenUs: object.seenUs,
            mesh,
            index,
            slot: new THREE.Vector3(x, y, z),
            ground: tile.layout.y + TILE_HEIGHT,
            shown: true,
            poppedAt: null,
          });
        }
      });
      cloudCentre.set(id, centre.divideScalar(slots.length));
      this.objectLayer.add(mesh);
      this.objectMeshes.set(id, mesh);
    }

    if (objects) {
      const component = new Map(objects.objects.map((o) => [o.id, o.componentId]));
      for (const wire of objects.wires) {
        const from = slotsByObject.get(wire.from);
        const to = slotsByObject.get(wire.to);
        if (from && to) this.addWire(from, to, component.get(wire.from)!, component.get(wire.to)!, wire.atUs);
      }
    } else {
      for (const held of wiring) {
        const from = cloudCentre.get(held.from);
        const to = cloudCentre.get(held.to);
        if (from && to) this.addWire(from, to, held.from, held.to, null);
      }
    }
    // A replay already under way keeps its clock across a new object graph.
    this.setObjectClock(this.clockUs, this.focusObject);
  }

  /**
   * Replay time: objects not yet built are hidden, and pop up out of their class's tile when
   * the clock passes the moment they were first seen; wires appear when their holder's
   * __init__ finished. The object doing the current step's work is lit. Null: show everything.
   */
  setObjectClock(tUs: number | null, focusObject: number | null): void {
    this.clockUs = tUs;
    this.focusObject = focusObject;
    advanceClock(this.objectInstances, tUs, performance.now());
    for (const wire of this.wireLines) wire.line.visible = tUs === null || wire.atUs === null || wire.atUs <= tUs;
  }

  /** Each frame: place every object at its scale and height, mid-pop or not. */
  private updateObjects(now: number): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const touched = new Set<THREE.InstancedMesh>();
    for (const instance of this.objectInstances) {
      // Rises out of its class's tile and overshoots a little before settling: a box popping out.
      const pose = popPose(instance, now);
      if (pose.settled) instance.poppedAt = null;
      position.copy(instance.slot);
      position.y = instance.ground + (instance.slot.y - instance.ground) * pose.risen;
      const size = instance.objectId === this.focusObject ? pose.size * FOCUS_SCALE : pose.size;
      matrix.compose(position, rotation, scale.setScalar(size));
      instance.mesh.setMatrixAt(instance.index, matrix);
      instance.mesh.setColorAt(instance.index, instance.objectId === this.focusObject ? FOCUS_COLOR : PLAIN_OBJECT);
      touched.add(instance.mesh);
    }
    for (const mesh of touched) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private addWire(from: THREE.Vector3, to: THREE.Vector3, fromId: string, toId: string, atUs: number | null): void {
    const control = from.clone().lerp(to, 0.5);
    control.y += WIRE_LIFT + from.distanceTo(to) * 0.1;
    const curve = new THREE.QuadraticBezierCurve3(from, control, to);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)),
      new THREE.LineDashedMaterial({ color: WIRE_COLOR, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.85 }),
    );
    line.computeLineDistances();
    this.objectLayer.add(line);
    this.wireLines.push({ from: fromId, to: toId, atUs, line });
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
      tile.outline.material.color.setHex(changeColor(change) ?? (tile.node.smells.length ? CHANGED_COLOR : zoneColor(this.profile, tile.node.zone)));
      tile.outline.material.opacity = emphasis === "dimmed" ? 0.2 : 1;
      const objects = this.objectMeshes.get(id);
      if (objects) (objects.material as THREE.MeshStandardMaterial).opacity = emphasis === "dimmed" ? DIMMED_OPACITY : 0.9;
      tile.label.element.style.opacity = emphasis === "dimmed" ? "0.3" : "1";
      tile.tier = active ? LabelTier.Active : emphasis === "highlighted" ? LabelTier.Highlighted : emphasis === "dimmed" ? LabelTier.Dimmed : LabelTier.Normal;
      tile.label.element.classList.toggle("active", active);
    }
    for (const [id, arc] of this.arcs) {
      const emphasis = edgeEmphasis(id);
      arc.mesh.material.color.setHex(changeColor(edgeChanges?.get(id) ?? null) ?? arc.baseColor);
      arc.mesh.material.opacity = emphasis === "dimmed" ? 0.05 : emphasis === "highlighted" ? 0.8 : 0.45;
    }
    for (const wire of this.wireLines) {
      const dimmed = [wire.from, wire.to].some((id) => {
        const tile = this.tiles.get(id);
        return tile !== undefined && nodeEmphasis(tile.node) === "dimmed";
      });
      wire.line.material.opacity = dimmed ? 0.08 : 0.85;
    }
    for (const trunk of this.trunks) {
      const anyLit = trunk.edgeIds.some((id) => edgeEmphasis(id) !== "dimmed");
      trunk.mesh.material.opacity = anyLit ? 0.12 : 0.03;
    }
  }

  /** Send a packet of light along a call's arc (backwards for a return). */
  pulse(edgeId: string, kind: StepKind, op: Op | null, durationMs: number): void {
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
    this.packets.push({ curve: arc.curve, reverse: kind === StepKind.Return, started: performance.now(), durationMs: Math.max(durationMs, MIN_PULSE_MS), head, trail });
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.labels.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.labels.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.clearWorld();
    this.controls.dispose();
    this.bloom.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    // Toggling 3D off and on must not pile up live GL contexts (browsers cap them).
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private addFloor(floor: Layout["floor"]): void {
    const grid = new THREE.PolarGridHelper(floor.radius * 2.6, 6, 8, 64, 0x2a3240, 0x1d232c);
    grid.position.y = -0.05;
    this.world.add(grid);
    for (const piece of floor.pieces) this.addFloorPiece(piece);
  }

  /** A flat polygon at its elevation; a raised one (a terrace) gets a face down to the ground. */
  private addFloorPiece(piece: FloorPiece): void {
    const color = piece.zone === null ? CORE_FLOOR_COLOR : zoneColor(this.profile, piece.zone);
    const shape = new THREE.Shape(piece.corners.map(([x, z]) => new THREE.Vector2(x, -z)));
    const floor = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: piece.zone === null ? 0.05 : 0.09, side: THREE.DoubleSide, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = piece.y;
    const rim = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(piece.corners.map(([x, z]) => new THREE.Vector3(x, piece.y + 0.05, z))),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }),
    );
    this.world.add(floor, rim);
    if (piece.y > 0) {
      // Posts at the corners, so a terrace reads as standing on the ground, not floating.
      const posts = piece.corners.flatMap(([x, z]) => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, piece.y, z)]);
      this.world.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(posts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 })));
    }
  }

  private addTile(node: LayoutNode, tile: FloorTile): void {
    const { x, y, z, size } = tile;
    const color = zoneColor(this.profile, node.zone);
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(size, TILE_HEIGHT, size),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, transparent: true, opacity: 0.55, roughness: 0.6 }),
    );
    body.position.set(x, y + TILE_HEIGHT / 2, z);
    body.userData.nodeId = node.id;
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color, transparent: true }));
    outline.position.copy(body.position);

    const element = document.createElement("button");
    element.type = "button";
    element.className = `label3d zone-${node.zone}`;
    element.textContent = node.label;
    element.title = `${node.qualifiedName ?? node.label}\n${node.zone}: ${node.zoneReason}`;
    // No click listener: orbit controls capture the pointer, so clicks are resolved in
    // handlePointerUp, which checks labels before tiles.
    element.dataset.nodeId = node.id;
    const label = new CSS2DObject(element);
    // Above the object cloud when the class has live objects, else just above the tile.
    label.position.set(x, y + (node.instances > 0 ? 9 : 3.2), z);
    this.world.add(body, outline, label);
    this.tiles.set(node.id, { node, body, outline, label, layout: tile, tier: LabelTier.Normal, labelSize: null });
  }

  /** Fit everything, from the client to the external systems, whatever the floor's shape. */
  private frameCamera(): void {
    const bounds = new THREE.Box3();
    for (const tile of this.tiles.values()) bounds.expandByObject(tile.body);
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const distance = (sphere.radius / Math.sin(halfFov)) * FRAMING;
    const fromFrontAbove = new THREE.Vector3(-0.15, 0.85, 0.9).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(fromFrontAbove, distance);
    this.controls.target.copy(sphere.center);
    this.controls.update();
  }

  private clearWorld(): void {
    for (const packet of this.packets.splice(0)) this.disposeObject(packet.head, packet.trail);
    for (const tile of this.tiles.values()) tile.label.element.remove();
    this.clearGroup(this.objectLayer);
    this.clearGroup(this.world);
    this.tiles.clear();
    this.arcs.clear();
    this.trunks.length = 0;
    this.objectMeshes.clear();
    this.wireLines.length = 0;
    this.objectInstances.length = 0;
    this.world.add(this.objectLayer); // emptied, not discarded: setObjects refills it
  }

  /**
   * Releases everything under a group, then empties it. GPU resources are freed during the
   * walk and the tree is detached only afterwards: removing children while traverse() is
   * iterating them would skip their siblings. The group itself stays attached.
   */
  private clearGroup(group: THREE.Group): void {
    for (const child of group.children) child.traverse(releaseResources);
    group.clear();
  }

  private disposeObject(...objects: THREE.Object3D[]): void {
    for (const object of objects) {
      releaseResources(object);
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
    this.updateObjects(now);
    this.composer.render();
    this.labels.render(this.scene, this.camera);
    this.framesDrawn += 1;
    if (this.framesDrawn % LABEL_CULL_EVERY_FRAMES === 0) this.cullLabels();
  };

  /** Hide labels that would overlap, keeping the most important (see labels.ts). */
  private cullLabels(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const position = new THREE.Vector3();
    const boxes: LabelBox[] = [];
    for (const [id, tile] of this.tiles) {
      const element = tile.label.element;
      if (tile.labelSize === null && element.offsetWidth > 0) {
        tile.labelSize = { width: element.offsetWidth, height: element.offsetHeight };
      }
      if (tile.labelSize === null) continue;
      tile.label.getWorldPosition(position).project(this.camera);
      if (position.z < -1 || position.z > 1) continue; // behind the camera
      boxes.push({
        id,
        x: ((position.x + 1) / 2) * width,
        y: ((1 - position.y) / 2) * height,
        width: tile.labelSize.width,
        height: tile.labelSize.height,
        priority: labelPriority(tile.tier, tile.node.calls),
      });
    }
    const visible = chooseVisibleLabels(boxes, { width, height });
    for (const [id, tile] of this.tiles) {
      if (tile.labelSize !== null) tile.label.element.style.visibility = visible.has(id) ? "" : "hidden";
    }
  }

  private advancePackets(now: number): void {
    for (let i = this.packets.length - 1; i >= 0; i -= 1) {
      const packet = this.packets[i]!;
      const progress = (now - packet.started) / packet.durationMs;
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
    const labelUnderPointer = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".label3d");
    const labelled = labelUnderPointer?.dataset.nodeId ? this.tiles.get(labelUnderPointer.dataset.nodeId) : undefined;
    if (labelled) {
      this.onPick(labelled.node);
      return;
    }
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

function releaseResources(object: THREE.Object3D): void {
  const disposable = object as Partial<THREE.Mesh>;
  disposable.geometry?.dispose();
  const material = disposable.material;
  if (Array.isArray(material)) material.forEach((m) => m.dispose());
  else material?.dispose();
}

function toVector([x, y, z]: Point): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function changeColor(change: Change | null): number | null {
  if (change === Change.Added) return ADDED_COLOR;
  if (change === Change.Removed) return REMOVED_COLOR;
  if (change === Change.Changed) return CHANGED_COLOR;
  return null;
}
