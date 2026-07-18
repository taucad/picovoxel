// Interactive three.js demo exercising the picogk-js/three subpath in both
// directions: toBufferGeometry for display, meshFromBufferGeometry for the
// torus-knot round trip. Apart from session swaps on voxel-size change, no
// wrapper is ever freed manually — the hidden disposal facade GC-frees them,
// which is exactly what it exists to demonstrate.
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
import { buildGearMesh } from '../src/gear.ts';
import type { CreatePicoGkOptions, Mesh, PicoGK } from '../src/index.ts';
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
let pk: PicoGK | undefined;
let pkVoxelSize = 0;
let pkThreading = '';
type PicoGkEntry = { createPicoGK: (options?: CreatePicoGkOptions) => Promise<PicoGK> };
async function session(voxelSize: number): Promise<PicoGK> {
  const threading = threadingSelect.value;
  if (pk === undefined || pkVoxelSize !== voxelSize || pkThreading !== threading) {
    pk?.dispose();
    const entry: PicoGkEntry = threading === 'multi' ? await import('../src/multi.ts') : await import('../src/index.ts');
    pk = await entry.createPicoGK({ voxelSize });
    pkVoxelSize = voxelSize;
    pkThreading = threading;
  }
  return pk;
}

// ── model builders — each returns the mesh to display plus a stats note ──
const mm3 = (volume: number) => `${volume.toFixed(0)} mm³`;

// `flat` — prismatic models (long thin coplanar cap triangles) shade wrong under
// interpolated vertex normals; dense voxel-mesher output wants smooth.
const builders: Record<string, (pk: PicoGK) => { mesh: Mesh; note: string; flat?: boolean }> = {
  gear(pk) {
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
    return { mesh: pk.createMesh({ vertices, triangles }), note: 'pure mesh — voxel size n/a', flat: true };
  },
  gyroid(pk) {
    // Serialized SDF (not a closure): compiled to a tape and filled in-module —
    // on the multi variant this is the only shape pthread workers can evaluate,
    // so the threading toggle actually pays here.
    const s = (2 * Math.PI) / 10;
    const gyroid = pk.createVoxels({
      shape: 'implicit',
      boundsMin: [-12, -12, -12],
      boundsMax: [12, 12, 12],
      sdf: ['-', ['abs', ['+',
        ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
        ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
        ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]]]], 0.4],
    });
    return { mesh: gyroid.toMesh(), note: mm3(gyroid.volume) };
  },
  csg(pk) {
    const sphere = pk.createVoxels({ shape: 'sphere', radius: 10 });
    const beam = (axis: 0 | 1 | 2) => {
      const start: [number, number, number] = [0, 0, 0];
      const end: [number, number, number] = [0, 0, 0];
      start[axis] = -12;
      end[axis] = 12;
      return pk.createVoxels({ shape: 'beam', start, end, radius: 3.5 });
    };
    const result = sphere.subtract(beam(0), beam(1), beam(2));
    return { mesh: result.toMesh(), note: mm3(result.volume) };
  },
  knot(pk) {
    const source = new TorusKnotGeometry(8, 2.5, 128, 24);
    const inMesh = meshFromBufferGeometry(pk, source);
    const voxels = inMesh.toVoxels();
    return { mesh: voxels.toMesh(), note: `${inMesh.triangleCount} tris in · ${mm3(voxels.volume)}` };
  },
};

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
    const voxelSize = currentVoxelSize();
    const startedAt = performance.now();
    const { mesh, note, flat } = builders[modelSelect.value]!(await session(voxelSize));
    const geometry = toBufferGeometry(mesh);
    if (material.flatShading !== (flat === true)) {
      material.flatShading = flat === true;
      material.needsUpdate = true;
    }
    const elapsed = Math.round(performance.now() - startedAt);
    geometry.center();
    displayed.geometry.dispose();
    displayed.geometry = geometry;
    if (lastModel !== modelSelect.value) {
      lastModel = modelSelect.value;
      geometry.computeBoundingSphere();
      const radius = geometry.boundingSphere?.radius ?? 20;
      camera.position.set(radius * 1.7, radius * 1.2, radius * 1.7);
      orbit.target.set(0, 0, 0);
    }
    const workers = pk?.module.PThread?.runningWorkers.length;
    const threadNote = workers === undefined ? 'single-threaded' : `${workers + 1} threads`;
    stats.textContent = `${mesh.vertexCount} verts · ${mesh.triangleCount} tris · ${note} · ${threadNote} · ${elapsed} ms`;
  } catch (error) {
    stats.textContent = String(error);
    throw error;
  } finally {
    controls.disabled = false;
  }
}

// The number input is the source of truth; the slider mirrors it.
const currentVoxelSize = () => Math.min(1, Math.max(0.05, Number(voxelNumber.value) || 0.5));

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
