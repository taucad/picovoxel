// Interactive three.js demo. Beyond exercising the picovoxel/three round trip,
// it runs every ported example headless in the browser so each can be eyeballed:
// pick one from the grouped dropdown, it builds against the live wasm session
// and displays the result. Apart from session swaps on voxel-size/threading
// change, no wrapper is freed manually — the hidden disposal facade GC-frees
// them, which is exactly what it exists to demonstrate.
import {
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh as ThreeMesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  TorusKnotGeometry,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { booleanShowcase } from '../examples/pico/boolean-showcase.ts';
import { buildGearMesh } from '../examples/pico/gear.ts';
import { helloWorld } from '../examples/pico/hello-world.ts';
import * as heatx from '../examples/helixheatx/run.ts';
import * as quasi from '../examples/quasicrystals/run.ts';
import * as rover from '../examples/roverwheel/run.ts';
import * as sim from '../examples/simulation/run.ts';
// ShapeKernel examples — every ex-* file exports `task(pk): Voxels[]`.
import * as skBasicLattices from '../examples/shapekernel/ex-basic-lattices.ts';
import * as skBox from '../examples/shapekernel/ex-base-box.ts';
import * as skCylinder from '../examples/shapekernel/ex-base-cylinder.ts';
import * as skGyroidGenus from '../examples/shapekernel/ex-implicit-gyroid-genus.ts';
import * as skGyroidSphere from '../examples/shapekernel/ex-implicit-gyroid-sphere.ts';
import * as skLatticeManifold from '../examples/shapekernel/ex-lattice-manifold.ts';
import * as skLatticePipe from '../examples/shapekernel/ex-lattice-pipe.ts';
import * as skLens from '../examples/shapekernel/ex-base-lens.ts';
import * as skMeshPainter from '../examples/shapekernel/ex-mesh-painter.ts';
import * as skMeshTrafo from '../examples/shapekernel/ex-mesh-trafo.ts';
import * as skOverOffset from '../examples/shapekernel/ex-over-offset.ts';
import * as skPipe from '../examples/shapekernel/ex-base-pipe.ts';
import * as skPipeSegment from '../examples/shapekernel/ex-base-pipe-segment.ts';
import * as skRing from '../examples/shapekernel/ex-base-ring.ts';
import * as skSphere from '../examples/shapekernel/ex-base-sphere.ts';
import * as skSuperEllipsoid from '../examples/shapekernel/ex-implicit-super-ellipsoid.ts';
// LatticeLibrary examples — same `task(pk): Voxels[]` shape.
import * as llConformal from '../examples/latticelibrary/ex-lattice-conformal.ts';
import * as llLogicSplit from '../examples/latticelibrary/ex-implicit-logic-split.ts';
import * as llModular from '../examples/latticelibrary/ex-implicit-modular.ts';
import * as llRadial from '../examples/latticelibrary/ex-implicit-radial.ts';
import * as llRandom from '../examples/latticelibrary/ex-implicit-random.ts';
import * as llRegular from '../examples/latticelibrary/ex-implicit-regular.ts';
import * as llRegularLattice from '../examples/latticelibrary/ex-lattice-regular.ts';
import type { CreatePicoOptions, Mesh, Pico, Voxels } from '../src/index.ts';
import { meshFromBufferGeometry, toBufferGeometry } from '../src/three.ts';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const controls = byId<HTMLFieldSetElement>('controls');
const modelSelect = byId<HTMLSelectElement>('model');
const voxelSlider = byId<HTMLInputElement>('voxel');
const voxelNumber = byId<HTMLInputElement>('voxelNumber');
const threadingSelect = byId<HTMLSelectElement>('threading');
const wireframeToggle = byId<HTMLInputElement>('wireframe');
const stats = byId<HTMLSpanElement>('stats');
const viewport = byId<HTMLDivElement>('viewport');

// The pthread build needs SharedArrayBuffer, which browsers gate behind
// cross-origin isolation (COOP/COEP response headers — see demo/serve.mjs).
if (!globalThis.crossOriginIsolated) {
  const multiOption = threadingSelect.querySelector<HTMLOptionElement>('option[value="multi"]');
  if (multiOption) {
    multiOption.disabled = true;
    multiOption.textContent = 'multi — needs COOP/COEP (node demo/serve.mjs)';
  }
}

// ── the example registry ──────────────────────────────────────────────────
// Each entry builds one Displayable from a live session. The voxel-size slider
// stays live for every example; `voxel` seeds the default it opens at, and a
// spread range widens/narrows the slider bounds where the geometry demands it
// (masked implicits break below ~1/3 mm; the super-ellipsoid lives near 0.02 mm;
// heavy subjects want coarse cells to stay interactive). Omit the range for the
// stock 0.05–1 mm / 0.05-step slider. `flat` marks prismatic meshes that shade
// wrong under smooth vertex normals.
type Displayable = Mesh | Voxels | Voxels[];
interface VoxelRange {
  min: number;
  max: number;
  step: number;
}
interface DemoEntry extends Partial<VoxelRange> {
  build: (pk: Pico) => Displayable;
  voxel?: number;
  flat?: boolean;
}

const DEFAULT_RANGE: VoxelRange = { min: 0.05, max: 1, step: 0.05 };
// Reusable slider bounds keyed to what each family can afford.
const RANGE = {
  shape: { min: 0.5, max: 2, step: 0.1 }, // large mesh shapes (±50 mm spans)
  lattice: { min: 0.25, max: 1, step: 0.05 }, // shapekernel lattice/offset fields
  masked: { min: 0.35, max: 1, step: 0.05 }, // masked implicits — upstream ⅓ mm floor
  heavyLattice: { min: 1, max: 2.5, step: 0.25 }, // beam lattices, already heavy at 1 mm
  subject: { min: 1, max: 4, step: 0.5 }, // RoverWheel / HeatX / QuasiCrystal
  micro: { min: 0.01, max: 0.1, step: 0.005 }, // the millimetre-scale super-ellipsoid
} satisfies Record<string, VoxelRange>;

// gyroid/csg/knot/gear keep the original hand-built demos.
const buildGyroid = (pk: Pico): Voxels => {
  // Serialized SDF (not a closure): compiled to a tape and filled in-module —
  // on the multi variant pthread workers can evaluate this, so threading pays.
  const s = (2 * Math.PI) / 10;
  return pk.createVoxels({
    shape: 'implicit',
    boundsMin: [-12, -12, -12],
    boundsMax: [12, 12, 12],
    sdf: ['-', ['abs', ['+',
      ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
      ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
      ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]]]], 0.4],
  });
};

const buildCsg = (pk: Pico): Voxels => {
  const sphere = pk.createVoxels({ shape: 'sphere', radius: 10 });
  const beam = (axis: 0 | 1 | 2) => {
    const start: [number, number, number] = [0, 0, 0];
    const end: [number, number, number] = [0, 0, 0];
    start[axis] = -12;
    end[axis] = 12;
    return pk.createVoxels({ shape: 'beam', start, end, radius: 3.5 });
  };
  return sphere.subtract(beam(0), beam(1), beam(2));
};

const buildKnot = (pk: Pico): Voxels => {
  const source = new TorusKnotGeometry(8, 2.5, 128, 24);
  return meshFromBufferGeometry(pk, source).toVoxels();
};

const buildGear = (pk: Pico): Mesh => {
  const vertices: number[] = [];
  const triangles: number[] = [];
  buildGearMesh(
    {
      meshCreate: () => 0n,
      addVertex: (_lib, _mesh, x, y, z) => (vertices.push(x, y, z), vertices.length / 3 - 1),
      addTriangle: (_lib, _mesh, a, b, c) => (triangles.push(a, b, c), triangles.length / 3 - 1),
    },
    0n,
  );
  return pk.createMesh({ vertices, triangles });
};

const GROUPS: Record<string, Record<string, DemoEntry>> = {
  'pico core': {
    'gyroid (implicit SDF)': { build: buildGyroid, voxel: 0.5 },
    'involute gear (mesh path)': { build: buildGear, voxel: 0.5, flat: true },
    'sphere − beams (CSG)': { build: buildCsg, voxel: 0.5 },
    'torus knot round-trip': { build: buildKnot, voxel: 0.5 },
    'hello cube (bulk mesh)': { build: helloWorld, voxel: 0.5, flat: true },
    'boolean showcase (∪ − ∩)': { build: (pk) => booleanShowcase(pk).mesh, voxel: 0.5 },
  },
  shapekernel: {
    'base box': { build: (pk) => skBox.task(pk), voxel: 1, ...RANGE.shape },
    'base cylinder': { build: (pk) => skCylinder.task(pk), voxel: 1, ...RANGE.shape },
    'base lens': { build: (pk) => skLens.task(pk), voxel: 1, ...RANGE.shape },
    'base pipe': { build: (pk) => skPipe.task(pk), voxel: 1, ...RANGE.shape },
    'base pipe segment': { build: (pk) => skPipeSegment.task(pk), voxel: 1, ...RANGE.shape },
    'base ring': { build: (pk) => skRing.task(pk), voxel: 1, ...RANGE.shape },
    'base sphere': { build: (pk) => skSphere.task(pk), voxel: 1, ...RANGE.shape },
    'basic lattices': { build: (pk) => skBasicLattices.task(pk), voxel: 0.5, ...RANGE.lattice },
    'lattice manifold': { build: (pk) => skLatticeManifold.task(pk), voxel: 0.5, ...RANGE.lattice },
    'lattice pipe': { build: (pk) => skLatticePipe.task(pk), voxel: 0.5, ...RANGE.lattice },
    'over-offset': { build: (pk) => skOverOffset.task(pk), voxel: 0.5, ...RANGE.lattice },
    'mesh painter': { build: (pk) => skMeshPainter.task(pk), voxel: 1, ...RANGE.shape },
    'mesh trafo': { build: (pk) => skMeshTrafo.task(pk), voxel: 1, ...RANGE.shape },
    'implicit gyroid ∩ sphere': { build: (pk) => skGyroidSphere.task(pk), voxel: 0.5, ...RANGE.masked },
    // genus intersect thins out fast as cells coarsen — keep the window tight.
    'implicit gyroid ∩ genus': { build: (pk) => skGyroidGenus.task(pk), voxel: 0.35, min: 0.35, max: 0.5, step: 0.05 },
    'implicit super-ellipsoid': { build: (pk) => skSuperEllipsoid.task(pk), voxel: 0.02, ...RANGE.micro },
  },
  latticelibrary: {
    'implicit regular': { build: (pk) => llRegular.task(pk), voxel: 0.5, ...RANGE.masked },
    'implicit modular': { build: (pk) => llModular.task(pk), voxel: 0.5, ...RANGE.masked },
    'implicit radial': { build: (pk) => llRadial.task(pk), voxel: 0.5, ...RANGE.masked },
    'implicit random': { build: (pk) => llRandom.task(pk), voxel: 0.5, ...RANGE.masked },
    'implicit logic-split': { build: (pk) => llLogicSplit.task(pk), voxel: 0.5, ...RANGE.masked },
    'conformal lattice': { build: (pk) => llConformal.task(pk), voxel: 1, ...RANGE.heavyLattice },
    'regular lattice': { build: (pk) => llRegularLattice.task(pk), voxel: 1, ...RANGE.heavyLattice },
  },
  subjects: {
    'RoverWheel — Wheel_02 (heavy)': { build: (pk) => rover.presetWheelTask(pk), voxel: 2, ...RANGE.subject },
    'RoverWheel — random seed 1 (heavy)': { build: (pk) => rover.randomWheelTask(pk, 1), voxel: 2, ...RANGE.subject },
    'HelixHeatX (heavy)': { build: (pk) => heatx.task(pk).voxels, voxel: 2, ...RANGE.subject },
    'Simulation — flow device': { build: (pk) => sim.writeTask(pk).solidDomain, voxel: 1, ...RANGE.shape },
    'QuasiCrystal — gen 0': { build: (pk) => quasi.wireframeFromCrystalTask(pk, 0).voxels, voxel: 2, ...RANGE.subject },
    'QuasiCrystal — gen 1': { build: (pk) => quasi.wireframeFromCrystalTask(pk, 1).voxels, voxel: 2, ...RANGE.subject },
    'QuasiCrystal — gen 2 (heavy)': { build: (pk) => quasi.wireframeFromCrystalTask(pk, 2).voxels, voxel: 2, ...RANGE.subject },
  },
};

// Flatten to a lookup and generate the grouped <option> list.
const entries = new Map<string, DemoEntry>();
modelSelect.replaceChildren();
for (const [groupName, group] of Object.entries(GROUPS)) {
  const optgroup = document.createElement('optgroup');
  optgroup.label = groupName;
  for (const [label, entry] of Object.entries(group)) {
    const key = `${groupName}/${label}`;
    entries.set(key, entry);
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    optgroup.append(option);
  }
  modelSelect.append(optgroup);
}
modelSelect.value = 'pico core/gyroid (implicit SDF)';

// ── three scene ──
const scene = new Scene();
scene.background = new Color(0x14161a);
scene.add(new HemisphereLight(0xdfe7f0, 0x2a2e36, 1.2));
const keyLight = new DirectionalLight(0xffffff, 1.6);
keyLight.position.set(30, 60, 45);
scene.add(keyLight);

const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
const renderer = new WebGLRenderer({ antialias: true });
viewport.append(renderer.domElement);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

const material = new MeshStandardMaterial({ color: 0x8fb4d8, metalness: 0.15, roughness: 0.55, side: DoubleSide });
const displayed = new ThreeMesh(undefined, material);
scene.add(displayed);

const resize = () => {
  const { clientWidth, clientHeight } = viewport;
  renderer.setSize(clientWidth, clientHeight);
  renderer.setPixelRatio(devicePixelRatio);
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
};
new ResizeObserver(resize).observe(viewport);
resize();
renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
});

// ── session, swapped when the voxel size or threading variant changes ──
// The variant is a dynamic import of the matching entry: each chunk pulls in
// only its own glue, mirroring how a consumer would feature-detect.
let pk: Pico | undefined;
let pkVoxelSize = 0;
let pkThreading = '';
type PicoEntry = { createPico: (options?: CreatePicoOptions) => Promise<Pico> };
async function session(voxelSize: number): Promise<Pico> {
  const threading = threadingSelect.value;
  if (pk === undefined || pkVoxelSize !== voxelSize || pkThreading !== threading) {
    pk?.dispose();
    const entry: PicoEntry = threading === 'multi' ? await import('../src/multi.ts') : await import('../src/index.ts');
    pk = await entry.createPico({ voxelSize });
    pkVoxelSize = voxelSize;
    pkThreading = threading;
  }
  return pk;
}

// ── resolve a Displayable to one mesh + a stat note ──
const mm3 = (volume: number) => `${volume.toFixed(0)} mm³`;
function resolveDisplay(display: Displayable): { mesh: Mesh; note: string } {
  if (Array.isArray(display)) {
    // Multiple pieces → combine into one field (separate pieces stay separate;
    // touching/overlapping ones merge — either way the whole example shows).
    const combined = display.length === 1 ? display[0]! : display[0]!.union(...display.slice(1));
    return { mesh: combined.toMesh(), note: mm3(combined.volume) };
  }
  if ('toMesh' in display) return { mesh: display.toMesh(), note: mm3(display.volume) };
  return { mesh: display, note: 'mesh path' }; // pure mesh — no voxels, tris already shown

}

// Seed the slider + number field to an example's bounds and default when it's
// selected; the user then drives the size freely within that range.
function applyVoxelConfig(entry: DemoEntry): void {
  const min = entry.min ?? DEFAULT_RANGE.min;
  const max = entry.max ?? DEFAULT_RANGE.max;
  const step = entry.step ?? DEFAULT_RANGE.step;
  const value = entry.voxel ?? 0.5;
  for (const input of [voxelSlider, voxelNumber]) {
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
  }
}

// ── rebuild ──
let lastModel = '';
async function rebuild(): Promise<void> {
  controls.disabled = true;
  stats.textContent = 'building…';
  // Yield one task so the disabled state can paint before the sync build. Not
  // requestAnimationFrame — RAF never fires in background tabs/embedded panes,
  // which would park the rebuild forever.
  await new Promise((resume) => setTimeout(resume, 0));
  try {
    const entry = entries.get(modelSelect.value)!;
    // On a model switch, reseat the slider to this example's range + default;
    // on a plain voxel change the slider already holds the value the user chose.
    const modelChanged = lastModel !== modelSelect.value;
    if (modelChanged) applyVoxelConfig(entry);
    const voxelSize = currentVoxelSize();
    const startedAt = performance.now();
    const { mesh, note } = resolveDisplay(entry.build(await session(voxelSize)));
    const geometry = toBufferGeometry(mesh);
    if (material.flatShading !== (entry.flat === true)) {
      material.flatShading = entry.flat === true;
      material.needsUpdate = true;
    }
    const elapsed = Math.round(performance.now() - startedAt);
    geometry.center();
    displayed.geometry.dispose();
    displayed.geometry = geometry;
    if (modelChanged) {
      lastModel = modelSelect.value;
      geometry.computeBoundingSphere();
      const radius = geometry.boundingSphere?.radius ?? 20;
      camera.position.set(radius * 1.7, radius * 1.2, radius * 1.7);
      orbit.target.set(0, 0, 0);
    }
    const workers = pk?.module.PThread?.runningWorkers.length;
    const threadNote = workers === undefined ? 'single-threaded' : `${workers + 1} threads`;
    stats.textContent =
      `${mesh.vertexCount} verts · ${mesh.triangleCount} tris · ${note} · ${voxelSize} mm · ${threadNote} · ${elapsed} ms`;
  } catch (error) {
    stats.textContent = String(error);
    throw error;
  } finally {
    controls.disabled = false;
  }
}

// The number input is the source of truth; the slider mirrors it. Clamp to the
// live bounds (each example sets its own via applyVoxelConfig).
const currentVoxelSize = () => {
  const min = Number(voxelSlider.min);
  const max = Number(voxelSlider.max);
  return Math.min(max, Math.max(min, Number(voxelNumber.value) || min));
};

modelSelect.addEventListener('change', rebuild);
threadingSelect.addEventListener('change', rebuild);
voxelSlider.addEventListener('input', () => {
  voxelNumber.value = voxelSlider.value;
});
voxelSlider.addEventListener('change', rebuild);
voxelNumber.addEventListener('change', () => {
  voxelNumber.value = String(currentVoxelSize());
  voxelSlider.value = voxelNumber.value;
  void rebuild();
});
wireframeToggle.addEventListener('change', () => {
  material.wireframe = wireframeToggle.checked;
});

// Debug/console handle — also handy for users poking at the scene.
(globalThis as { __demo?: unknown }).__demo = { scene, camera, renderer, displayed, material, orbit };

await rebuild();
