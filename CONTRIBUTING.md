# Contributing

1. Fork or branch from `main`.
2. Use Node `^22.18.0 || ^24.11.0 || >=26.0.0`, where the ranges the build
   tools declare meet (tsdown `^22.18.0 || >=24.11.0`, size-limit
   `^22.18.0 || ^24.0.0 || >=26.0.0`). The published package supports Node
   22.14.0 and later; CI tests that floor against the packed tarball, so
   contributors do not need it locally.
3. Install with `pnpm install --frozen-lockfile`.
4. Put both wasm pairs in `src/`: build them with the commands under "Building
   from source" in the README, or copy the `wasm-serial` and `wasm-multi`
   artifacts of a green `ci.yml` run.
5. Add tests that assert the changed public behavior. TypeScript coverage over
   `src/` stays at 100%, and each C++ translation unit (`src/pico-*.cpp`) stays
   at 100% lines and functions in the `coverage-cpp` job;
   `scripts/coverage-cpp-gate.mjs` shows the local run.
6. Run `pnpm nx run picovoxel:quality` and `pnpm run test:unit`. The whole suite
   (`pnpm nx run picovoxel:test`) takes about 33 minutes; CI runs it sharded on
   every pull request.
7. Add a Version Plan with `pnpm nx release plan` when package behavior or
   shipped artifacts change. Pending plans set the next version and its
   changelog entry.
8. Update a byte budget in the causing pull request when the larger artifact is
   intentional (`.size-limit.json`, the file-count ceiling in
   `scripts/package-files.mjs`, the wasm ceilings in `scripts/wasm-manifest.mjs`).
   Explain the measured origin beside the threshold.
9. Rename a benchmark when its semantics change: a `bench/run.mjs` metric (for
   example `M12` to `M12-v2`), or `NAME` in `bench/gated.mjs` when a pull
   request changes the HeatX geometry on purpose, since the `benchmark` job
   fails when the G0 tuple differs from `main`. Do not overwrite an identity
   to hide a new workload.
10. Never regenerate a byte-locked fixture to make a test pass. A change to the
    bytes an `exact` session produces is a breaking change: explain its cause in
    the pull request and record it in `BREAKING_CHANGES.md`.
11. Open a pull request with commands and results, and complete the template,
    including the AI disclosure.

Only GitHub Actions publishes npm packages, creates tags or releases, and
deploys documentation. Never run `npm publish` from a workstation.
