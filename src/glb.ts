// Minimal GLB writer. GLB is a 12-byte header plus two chunks (JSON, BIN), so a
// dependency would cost more than it saves — and Tau's own createGlb is not
// reachable from this standalone repo.
// ponytail: positions + indices only. No normals/materials/colors until something asks.

const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

const pad4 = (n: number): number => (n + 3) & ~3;

/**
 * @param vertices xyz triples
 * @param indices triangle corner indices
 * @returns GLB bytes
 */
export function createGlb(vertices: Float32Array, indices: Uint32Array): Uint8Array {
  // glTF requires accessor min/max on POSITION — viewers use it for framing.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }

  const vertexBytes = vertices.byteLength;
  const indexOffset = pad4(vertexBytes);
  const binLength = pad4(indexOffset + indices.byteLength);

  const gltf = {
    asset: { version: '2.0', generator: 'picogk-js' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertexBytes, target: TARGET_ARRAY_BUFFER },
      { buffer: 0, byteOffset: indexOffset, byteLength: indices.byteLength, target: TARGET_ELEMENT_ARRAY_BUFFER },
    ],
    accessors: [
      { bufferView: 0, componentType: COMPONENT_FLOAT, count: vertices.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: COMPONENT_UINT, count: indices.length, type: 'SCALAR' },
    ],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, MAGIC, true); o += 4;
  view.setUint32(o, 2, true); o += 4;
  view.setUint32(o, total, true); o += 4;

  view.setUint32(o, jsonLength, true); o += 4;
  view.setUint32(o, JSON_CHUNK, true); o += 4;
  out.set(jsonBytes, o);
  out.fill(0x20, o + jsonBytes.length, o + jsonLength); // JSON chunk pads with spaces
  o += jsonLength;

  view.setUint32(o, binLength, true); o += 4;
  view.setUint32(o, BIN_CHUNK, true); o += 4;
  out.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertexBytes), o);
  out.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), o + indexOffset);
  return out;
}
