// PicoGK's C# surface, mirrored in TypeScript over picovoxel's raw ABI. The translator
// translates the language only: a C# call `vox.voxIntersectImplicit(sdf)` stays that call,
// and this module answers it. Names, overloads and float32 semantics follow the C#
// library, so translated programs need no per-program API mapping. Only the members the
// spike's programs reach are here; the rest of the surface is the same kind of code.
import { loadPicoRaw, type PicoHandle, type PicoRaw } from '../../../src/raw.ts';
import { compileSdfExpression, type SdfExpression } from '../../../src/tape.ts';
import type { PicoWasmModule } from '../../../src/types.ts';

export const f = Math.fround;

// --- System.Numerics.Vector3: an immutable float32 triple -------------------------------
export class Vector3 {
  readonly X: number;
  readonly Y: number;
  readonly Z: number;
  constructor(x?: number, y?: number, z?: number) {
    if (x === undefined) this.X = this.Y = this.Z = 0;
    else if (y === undefined) this.X = this.Y = this.Z = f(x);
    else [this.X, this.Y, this.Z] = [f(x), f(y), f(z!)];
  }
  static op_Addition(a: Vector3, b: Vector3): Vector3 {
    return new Vector3(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
  }
  static op_Subtraction(a: Vector3, b: Vector3): Vector3 {
    return new Vector3(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
  }
  static op_UnaryNegation(a: Vector3): Vector3 {
    return new Vector3(-a.X, -a.Y, -a.Z);
  }
  static op_Multiply(a: Vector3 | number, b: Vector3 | number): Vector3 {
    if (typeof a === 'number')
      return new Vector3(a * (b as Vector3).X, a * (b as Vector3).Y, a * (b as Vector3).Z);
    if (typeof b === 'number') return new Vector3(a.X * b, a.Y * b, a.Z * b);
    return new Vector3(a.X * b.X, a.Y * b.Y, a.Z * b.Z);
  }
  static op_Division(a: Vector3, b: number): Vector3 {
    return new Vector3(a.X / b, a.Y / b, a.Z / b);
  }
  static Dot(a: Vector3, b: Vector3): number {
    return f(f(f(a.X * b.X) + f(a.Y * b.Y)) + f(a.Z * b.Z));
  }
  LengthSquared(): number {
    return Vector3.Dot(this, this);
  }
  Length(): number {
    return f(Math.sqrt(this.LengthSquared()));
  }
}

export class BBox3 {
  vecMin: Vector3;
  vecMax: Vector3;
  constructor(vecMin = new Vector3(Infinity), vecMax = new Vector3(-Infinity)) {
    this.vecMin = vecMin;
    this.vecMax = vecMax;
  }
}

export class ColorFloat {
  readonly strHex: string;
  constructor(strHex: string) {
    this.strHex = strHex;
  }
}

/** C#'s IImplicit. A translated class may also carry the lifted SDF (`__sdf`). */
export interface IImplicit {
  fSignedDistance(vecPt: Vector3): number;
  __sdf?(): SdfExpression;
}
/** Set by the translator on a class whose lifted tape reproduces the C# bytes. */
type Lifted = { __sdfExact?: boolean };

// --- Library: the instance, the scratch heap, the lane --------------------------------
export type Lane = 'exact' | 'fast';
export const stats = { tapeRenders: 0, callbackRenders: 0, callbackCalls: 0 };

export class Library {
  static #global: Library | null = null;
  readonly hThis: PicoHandle;
  readonly raw: PicoRaw;
  readonly module: PicoWasmModule;
  readonly fVoxelSize: number;
  readonly lane: Lane;
  private readonly scratch: number;
  constructor(raw: PicoRaw, module: PicoWasmModule, fVoxelSize: number, lane: Lane) {
    this.raw = raw;
    this.module = module;
    this.fVoxelSize = fVoxelSize;
    this.lane = lane;
    this.hThis = raw.Library_hCreateInstance(fVoxelSize);
    this.scratch = module._malloc(256);
  }
  static async Create(fVoxelSizeMM: number, lane: Lane = 'exact'): Promise<Library> {
    const { raw, module } = await loadPicoRaw();
    const lib = new Library(raw, module, fVoxelSizeMM, lane);
    Library.#global = lib;
    return lib;
  }
  static oLibrary(): Library {
    if (!Library.#global) throw new Error('Your code relies on being called using Library::Go');
    return Library.#global;
  }
  static Log(str: string): void {
    console.log(str);
  }
  writeBBox(box: BBox3): number {
    const h = this.module.HEAPF32,
      i = this.scratch >>> 2;
    h.set([box.vecMin.X, box.vecMin.Y, box.vecMin.Z, box.vecMax.X, box.vecMax.Y, box.vecMax.Z], i);
    return this.scratch;
  }
  readVec3(at = this.scratch): Vector3 {
    const h = this.module.HEAPF32,
      i = at >>> 2;
    return new Vector3(h[i]!, h[i + 1]!, h[i + 2]!);
  }
  get ptr(): number {
    return this.scratch;
  }

  /** Lane choice for one implicit: the tape when it is exact, or when the session took the fast lane. */
  useTape(xImp: IImplicit & Lifted): boolean {
    return typeof xImp.__sdf === 'function' && (xImp.__sdfExact === true || this.lane === 'fast');
  }
  withTape<T>(xImp: IImplicit, body: (pn: number, nn: number, pf: number, nf: number) => T): T {
    const { instructions, constants } = compileSdfExpression(xImp.__sdf!());
    const m = this.module;
    const pn = m._malloc(instructions.byteLength),
      pf = m._malloc(Math.max(8, constants.byteLength));
    try {
      m.HEAPU32.set(instructions, pn >>> 2);
      m.HEAPF64.set(constants, pf >>> 3);
      stats.tapeRenders++;
      return body(pn, instructions.length / 2, pf, constants.length);
    } finally {
      m._free(pf);
      m._free(pn);
    }
  }
  withCallback<T>(xImp: IImplicit, body: (pfn: number) => T): T {
    const m = this.module;
    const pfn = m.addFunction((p: number) => {
      const h = m.HEAPF32,
        i = p >>> 2;
      stats.callbackCalls++;
      return xImp.fSignedDistance(new Vector3(h[i]!, h[i + 1]!, h[i + 2]!));
    }, 'fi');
    try {
      stats.callbackRenders++;
      return body(pfn);
    } finally {
      m.removeFunction(pfn);
    }
  }
}

// --- Voxels and Mesh: the C# overloads, dispatched on argument shape --------------------
const isImplicit = (o: unknown): o is IImplicit =>
  typeof o === 'object' && o !== null && typeof (o as IImplicit).fSignedDistance === 'function';

export class Voxels {
  readonly lib: Library;
  readonly hThis: PicoHandle;
  constructor(...args: unknown[]) {
    const [a, b] = args;
    if (a instanceof Voxels) {
      this.lib = a.lib;
      this.hThis = this.lib.raw.Voxels_hCreateCopy(this.lib.hThis, a.hThis);
    } else if (a instanceof Mesh) {
      this.lib = a.lib;
      this.hThis = this.lib.raw.Voxels_hCreate(this.lib.hThis);
      this.lib.raw.Voxels_RenderMesh(this.lib.hThis, this.hThis, a.hThis);
    } else if (isImplicit(a) && b instanceof BBox3) {
      this.lib = Library.oLibrary();
      this.hThis = this.lib.raw.Voxels_hCreate(this.lib.hThis);
      this.RenderImplicit(a, b);
    } else if (a === undefined || a instanceof Library) {
      this.lib = (a as Library | undefined) ?? Library.oLibrary();
      this.hThis = this.lib.raw.Voxels_hCreate(this.lib.hThis);
    } else {
      throw new Error(`Voxels: no overload takes (${args.map((x) => x?.constructor?.name).join(', ')})`);
    }
  }
  RenderImplicit(xImp: IImplicit, oBounds: BBox3): void {
    const { raw, hThis: hLib } = this.lib;
    if (this.lib.useTape(xImp)) {
      const pBox = this.lib.writeBBox(oBounds);
      this.lib.withTape(xImp, (pn, nn, pf, nf) =>
        raw.Voxels_RenderImplicitTape(hLib, this.hThis, pBox, pn, nn, pf, nf),
      );
    } else {
      this.lib.withCallback(xImp, (pfn) =>
        raw.Voxels_RenderImplicit(hLib, this.hThis, this.lib.writeBBox(oBounds), pfn),
      );
    }
  }
  IntersectImplicit(xImp: IImplicit): void {
    const { raw, hThis: hLib } = this.lib;
    if (this.lib.useTape(xImp)) {
      this.lib.withTape(xImp, (pn, nn, pf, nf) =>
        raw.Voxels_IntersectImplicitTape(hLib, this.hThis, pn, nn, pf, nf),
      );
    } else {
      this.lib.withCallback(xImp, (pfn) => raw.Voxels_IntersectImplicit(hLib, this.hThis, pfn));
    }
  }
  voxIntersectImplicit(xImp: IImplicit): Voxels {
    const vox = this.voxDuplicate();
    vox.IntersectImplicit(xImp);
    return vox;
  }
  voxDuplicate(): Voxels {
    return new Voxels(this);
  }
  mshAsMesh(): Mesh {
    return new Mesh(this);
  }
  /** C# `CalculateProperties(out float, out BBox3)`: out parameters come back as a tuple. */
  CalculateProperties(): [number, BBox3] {
    const msh = new Mesh(this);
    const vox = new Voxels(msh);
    const fVolume = this.lib.raw.Voxels_fCalculateVolume(this.lib.hThis, vox.hThis);
    vox.Dispose();
    msh.Dispose();
    return [f(fVolume), new BBox3()];
  }
  Dispose(): void {
    this.lib.raw.Voxels_Destroy(this.lib.hThis, this.hThis);
  }
}

export class Mesh {
  readonly lib: Library;
  readonly hThis: PicoHandle;
  constructor(vox: Voxels) {
    this.lib = vox.lib;
    this.hThis = this.lib.raw.Mesh_hCreateFromVoxels(this.lib.hThis, vox.hThis);
  }
  nTriangleCount(): number {
    return this.lib.raw.Mesh_nTriangleCount(this.lib.hThis, this.hThis);
  }
  nVertexCount(): number {
    return this.lib.raw.Mesh_nVertexCount(this.lib.hThis, this.hThis);
  }
  vecVertexAt(n: number): Vector3 {
    this.lib.raw.Mesh_GetVertex(this.lib.hThis, this.hThis, n, this.lib.ptr);
    return this.lib.readVec3();
  }
  oTriangleAt(n: number): { A: number; B: number; C: number } {
    this.lib.raw.Mesh_GetTriangle(this.lib.hThis, this.hThis, n, this.lib.ptr);
    const h = this.lib.module.HEAP32,
      i = this.lib.ptr >>> 2;
    return { A: h[i]!, B: h[i + 1]!, C: h[i + 2]! };
  }
  Dispose(): void {
    this.lib.raw.Mesh_Destroy(this.lib.hThis, this.hThis);
  }
}

// --- The viewer and ShapeKernel's preview helpers, as the web host records them ------------
export const shown: Array<{ vox: Voxels; clr: ColorFloat; fAlpha: number }> = [];

export const Leap71_ShapeKernel = {
  Sh: {
    PreviewVoxels(vox: Voxels, clr: ColorFloat, fAlpha = 1): number {
      shown.push({ vox, clr, fAlpha });
      return shown.length - 1;
    },
  },
  Cp: {
    clrBillie: new ColorFloat('#02f70b'),
    clrBubblegum: new ColorFloat('#ff66ce'),
  },
};
