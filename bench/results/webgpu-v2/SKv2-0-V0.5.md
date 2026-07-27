# SKv2-0 V0.5 ★ — lane API surfacing (§14.1), carrying the rescoped V0.6

**Verdict: LANDED.** The two-lane reality created by V0.3/V0.4 now has its
surface: named bundles, tighten-only precedence, per-handle provenance with
LUB over ancestry, the refusing L0 export boundary, provenance in artifact
metadata, and the keyed `serialLattice` init option replacing the deleted
env read. The V0.4 `fastRenorm` flip binds here, inside the named `'fast'`
bundle — the §14 landing-order obligation discharged.

## The surface

| Piece | Shape |
| --- | --- |
| Request | `createPico({ lane: 'exact' \| 'fast' \| 'auto' })`; omitted = `'open'` (no claim — the pre-lane behavior, exactly; zero breakage for existing consumers, fixtures, or pins) |
| Resolution | `'auto'` resolves AT CONSTRUCTION (to `'fast'` today; adapter-qualified GPU lanes later); `session.lane` reports only resolved values — an unresolved `'auto'` is precisely the value that would key identically while resolving differently |
| `'exact'` | Byte-locked numerics policy, LOCKED: `{ lane: 'exact', fastRenorm: true }` throws `PICO_LANE_LOOSENED` at construction; per-op `fastRenorm: true` throws at the call, on all five offset-family members. The L0 *oracle* remains this policy on the serial artifact |
| `'fast'` | `fastRenorm` defaults on (the V0.4 flip, named); per-op AND session-level tightening allowed (`{ lane: 'fast', fastRenorm: false }` = byte-locked values on the fast artifact — what the cross-lane G0 harness measures) |
| Provenance | `.lane` on Voxels/Mesh/ScalarField/VectorField: `'exact'` by construction, tainted by the Class-2 producer (`fastRenorm` engagement), LUB over every derive (booleans in either operand position, clones, `toMesh`, `transform`/`merged`, `withMesh`, field creation from voxels) |
| Persistence | `'fast'` provenance writes `PicoVoxel.Lane` grid metadata — rides native copies and `.vdb` bytes with zero serializer changes; wrap-time tag reads restore it on load. Absence of the tag IS the exact claim, so byte-locked exact fixtures are untouched. The name is reserved at the public metadata surface (`PICO_RESERVED_METADATA`) — provenance is not forgeable |
| Export boundary | `toStl()`/`toGlb()`/`vdb.toBytes()` throw `PICO_LANE_EXPORT` on fast provenance unless acknowledged (`acceptLane: 'fast'`); acknowledged STL exports stamp `LANE=fast` in the 80-byte header and `meshFromStl` restores provenance from it; exact exports keep the byte-identical historical header. Canonical-serialization routing for acknowledged exports arrives with V0.18 (§12.8) |
| V0.6 (rescoped) | `PICOVOXEL_SERIAL_LATTICE` env read **deleted** (`resolveRenderLatticeExport` and the module-load constant are gone); the serial C#-identical arm is `createPico({ serialLattice: true })` — a keyed, constructor-explicit init option, per-session where the env read could not even differ between two sessions in one process |

## Exit assertions (charter row)

1. **Precedence matrix tested** — `test/lanes.test.ts`: open/exact/fast ×
   per-op absent/false/true, cross-checked by G0 grid hash (bundle default ≡
   per-op opt-in; both tightening grains ≡ the L0 path exactly).
2. **Loosening inside `'exact'` throws** — construction-time and per-op, all
   five family members.
3. **Provenance survives derive chains** — boolean LUB both operand
   positions, clone/offset chains, mesh and field boundaries.
4. **Export refusal + acknowledgment path tested** — STL/GLB/VDB refusals,
   acknowledged export, header stamp, STL and VDB round-trips restoring
   `'fast'`, exact paths byte-untouched, forgery rejection.
5. **Env-var path deleted + option keyed** — `serialLattice` differential:
   the two arms are byte-different geometry classes (why the flag must key),
   each deterministic (×2 sessions), `withLattice` follows the same arm.
6. **`session.lane` reports the resolved lane** — `'auto'` → `'fast'`,
   omitted → `'open'`, never `'auto'`.

Suite: 52 files, 484/484, coverage 100% enforced. Browser gate 3×17/17
(dist rebuilt). No pin moved anywhere — `'open'` semantics are pre-V0.5
behavior exactly, so every byte-locked fixture, G0 pin, and the g0-gate ran
unchanged.

## Notes

- The identity harness needs no changes: its default sessions are `'open'`
  (byte-locked values). When fast-lane G1 legs are added to the sweeps, the
  session shape is `{ lane: 'fast' }` vs `{ lane: 'fast', fastRenorm:
  false }` — tightening inside the fast lane is how cross-lane byte
  comparability is expressed post-V0.5.
- Re-canonicalization is a replay, not a conversion: there is no map from
  Class-2 values back to L0 values. The API's refusal text says so.
- GLB carries no provenance slot in our writer; STL and VDB do. Recorded as
  a V0.18 rider (canonical export mode is where GLB metadata would land).
