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
import { createPicoGK, type Mesh, type PicoGK } from '../src/index.ts';
import { meshFromBufferGeometry, toBufferGeometry } from '../src/three.ts';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const controls = byId<HTMLFieldSetElement>('controls');
const modelSelect = byId<HTMLSelectElement>('model');
const voxelSlider = byId<HTMLInputElement>('voxel');
const voxelValue = byId<HTMLSpanElement>('voxelValue');
const wireframeToggle = byId<HTMLInputElement>('wireframe');
const stats = byId<HTMLSpanElement>('stats');
const viewport = byId<HTMLDivElement>('viewport');

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

// ── session, swapped when the voxel size changes ──
let pk: PicoGK | undefined;
let pkVoxelSize = 0;
async function session(voxelSize: number): Promise<PicoGK> {
  if (pk === undefined || pkVoxelSize !== voxelSize) {
    pk?.dispose();
    pk = await createPicoGK({ voxelSize });
    pkVoxelSize = voxelSize;
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
    const s = (2 * Math.PI) / 10;
    const gyroid = pk.createVoxels({
      shape: 'implicit',
      boundsMin: [-12, -12, -12],
      boundsMax: [12, 12, 12],
      sdf: (x, y, z) =>
        Math.abs(Math.sin(x * s) * Math.cos(y * s) + Math.sin(y * s) * Math.cos(z * s) + Math.sin(z * s) * Math.cos(x * s)) -
        0.4,
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
  await new Promise(requestAnimationFrame); // let the disabled state paint before the sync build
  try {
    const voxelSize = Number(voxelSlider.value);
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
    stats.textContent = `${mesh.vertexCount} verts · ${mesh.triangleCount} tris · ${note} · ${elapsed} ms`;
  } catch (error) {
    stats.textContent = String(error);
    throw error;
  } finally {
    controls.disabled = false;
  }
}

modelSelect.addEventListener('change', rebuild);
voxelSlider.addEventListener('change', rebuild);
voxelSlider.addEventListener('input', () => {
  voxelValue.textContent = `${Number(voxelSlider.value).toFixed(2)} mm`;
});
wireframeToggle.addEventListener('change', () => {
  material.wireframe = wireframeToggle.checked;
});

await rebuild();
