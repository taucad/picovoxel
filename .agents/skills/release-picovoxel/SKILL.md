---
name: release-picovoxel
description: Audits picovoxel release state or prepares release files locally for inspection. Use when the current task asks to audit or prepare a picovoxel npm release.
argument-hint: '[status | prepare <version>]'
---

# Release picovoxel

GitHub Actions is the sole owner of npm publication, provenance, tags, and
GitHub Releases. Releases ship through the standing release pull request that
`release-pr.yml` maintains on `release/next`; a maintainer squash-merging it is
the entire release act. This repository publishes one package, `picovoxel`;
the Tau plugin `@taucad/picovoxel` is released from the Tau repository.

## Modes

- `status`: inspect the package version, Version Plans, the standing release
  pull request, recent `ci.yml` and `release-pr.yml` runs, the npm versions,
  dist-tags and provenance of `picovoxel`, and GitHub Releases. Report which
  release prerequisites in `MAINTAINER.md` do not hold.
- `prepare <version>`: validate and generate release files locally for
  inspection, then stop without committing or pushing. The automation runs the
  same generation as `pnpm release:prepare -- --from-plans`.

Map natural requests to the matching mode; reject unsupported modes. There is
no submit mode: `release-pr.yml` regenerates the release pull request after
every successful `main` CI run. `MAINTAINER.md` documents the manual fallback
for a broken bot.

## Prepare

1. Require the release prerequisites in `MAINTAINER.md`, including the
   `release:prepare` script in `package.json`; stop and report any that fail.
2. Require clean `main`, `HEAD == origin/main`, a Version Plan, stable exact
   SemVer, and that the requested version matches what the plans produce.
3. Audit the npm Trusted Publisher with `npm trust list picovoxel --json`:
   repository `taucad/picovoxel`, workflow `ci.yml`, publish allowed, no
   environment. Never replace a correct binding.
4. Put both CI-built wasm pairs in `src/` (the `wasm-serial` and `wasm-multi`
   artifacts of the green `main` run); the release tarball ships them.
5. Run `pnpm release:prepare -- <version> --dry-run`, then the real run. Both
   run the `quality` gate once.
6. Require changes only to `package.json`, `CHANGELOG.md`, and consumed
   `.nx/version-plans/*.md` files (`pnpm-lock.yaml` is permitted, never
   required).
7. Run `git diff --check`, then stop and report; discard the working tree
   rather than committing it.

## Boundaries

- Never run `npm publish`, create tags or releases, add `NPM_TOKEN`, or change
  repository or registry settings.
- Never push to `release/next`, enable auto-merge on the release pull request,
  or merge it; merging publishes and is the maintainer's act.
- Never mix source changes into a release commit.
- Never edit generated changelog text without reconciling the Version Plan.
- Never regenerate a byte-locked fixture during a release.
- Stop when the trusted publisher binding is missing or wrong; binding and
  npmjs.com publishing access are operator acts.
