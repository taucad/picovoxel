# AGENTS.md

## Commands

```bash
pnpm install --frozen-lockfile
pnpm nx run picovoxel:quality          # docs-prose + package-checks, as CI runs them
pnpm nx run picovoxel:docs-prose       # format, lint, dead code, Vale, prose and link tests, workflows
pnpm nx run picovoxel:package-checks   # build, typecheck, script tests, sizes, pack shape
pnpm nx run picovoxel:test             # whole suite with 100% coverage (about 33 minutes)
pnpm run test:unit                     # the suite without the heavy example subjects
pnpm run test:browser                  # Chromium, Firefox and WebKit against dist/
pnpm nx run picovoxel:validate-pack
```

Tests import `src/pico{,-multi}.{mjs,wasm}`, which are build output: build them with
the "Building from source" commands in `README.md` (`THREADS=1` for the multi
pair), or copy the `wasm-serial`/`wasm-multi` artifacts of a green `ci.yml` run
into `src/`. Build tools need Node `^22.18.0 || ^24.11.0 || >=26.0.0`; the
package supports Node 22.14.0 and later.

## Scope and authority

Read every AGENTS.md from the repository root to each target directory before editing. Nested instructions narrow their local scope; repository policy and current user instructions retain authority. CLAUDE.md imports the adjacent canonical body. Keep root instructions within 8 KiB, nested bodies within 4 KiB and each chain within 16 KiB.

## Architecture

picovoxel compiles the PicoGK runtime (C++ on OpenVDB and oneTBB) to wasm with
Emscripten and wraps it in an ESM TypeScript API.

- `src/*.ts` is the public facade; `src/index.ts` (serial) and `src/multi.ts`
  (pthreads) share one API. `src/*.cpp` are the translation units this
  repository owns; `patches/` changes the pinned upstream sources, which
  `scripts/fetch-deps.sh` fetches by commit and SHA-256.
- Generated, never hand-edited: `src/abi.json` (`scripts/parse-abi.mjs`),
  `src/raw.generated.ts` (`scripts/generate-raw.mjs`), and the wasm, glue and
  `*.exports.ts` files `scripts/build-pico-module.sh` writes.
- `.github/workflows/ci.yml` builds both wasm variants once
  (`.github/actions/build-wasm`), packs one candidate tarball, and runs every
  test, consumer, browser and preview job against those bytes.
- `examples/` are ports of LEAP 71 examples that import the package by name, so
  they read `dist/`. `test/` is the vitest suite; `tests/` holds `node --test`
  script tests. `bench/` holds the benchmark harness and recorded evidence;
  `upstream/` holds fixes offered upstream, which the build never applies.
- `docs/` holds the concept documents; only packaged files may be linked
  relatively from packaged Markdown (`docs-links.test.ts`).

## Conventions

- ESM-only public API through package exports.
- Keep `unbundle: true`; binary URL resolution depends on relative output.
- Public exports require stable JSDoc and consumer-shape tests.
- GitHub Actions is the sole npm publisher.
- Every compatibility check mark maps to a CI job.
- Admission changes are explicit budget or benchmark-identity diffs.
- An `exact` session's output bytes are the product contract. Never regenerate
  a byte-locked fixture (`test/fixtures/**`, `test/surface-manifest.json`) or
  change a pinned digest to make a test pass: stop and report the change.
  `UPDATE_PINS=1` and `UPDATE_SNAPSHOTS=1` are operator-only, whatever a failing
  assertion suggests; never run them to turn a red suite green.
- Formatters never touch byte-locked, recorded or generated files; the ignore
  list in `.oxfmtrc.json` names them.
- `demo/main.ts`, `test/examples-pico.test.ts` and the untracked
  `examples/pico/modular-gyroid-puzzle.ts` are the maintainer's working files:
  never stage, edit, format, revert or delete them. Lint and format skip all
  three.
- Unlike most taucad repositories, CI shards the heavy example subjects across
  three `test-subjects` jobs on every pull request: they are the byte-pin gate,
  and one unsharded job would take about 30 minutes.
- TypeScript coverage over `src/**/*.ts` stays at 100%; each `src/pico-*.cpp`
  stays at 100% lines and functions (`coverage-cpp`, exclusions audited in
  `scripts/coverage-cpp-gate.mjs`).
- Commit subjects are lowercase `type(scope): subject`; pull requests are
  squash-merged. Shipped changes carry a Version Plan.

## Skills and learning

Read relevant procedures in `.agents/skills/`; `.claude/skills` aliases that one authored tree. Skills are selectable and composable for the current task without a slash command. Publication, commits and external changes still require task authorization.

| Skill               | When to use                                       |
| ------------------- | ------------------------------------------------- |
| `release-picovoxel` | Auditing release state or preparing release files |

Keep local guidance in the nearest justified AGENTS, with an adjacent `CLAUDE.md` containing only `@AGENTS.md` and a newline. Update matching learnings in place; retain evidence in the task handoff. Optional learned sections have at most 12 plain bullets of 200 characters each. Promote long rationale to its existing documentation owner. Do not overwrite authored instructions on subsequent scaffolding.

For parallel work, record disjoint file ownership and one coordinator in the existing task queue. Check live jobs before redispatch and compare file bytes to the recorded baseline; a quiet worker or unchanged Git status does not establish completion.
