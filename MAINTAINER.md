# Maintainer Guide

## Pull requests

Require `ci-gate`, a Version Plan for shipped changes, and reviewable admission
edits for byte or timing regressions. Zero approvals is the solo-maintainer
ruleset; revisit it when a second maintainer joins. Squash-merge with the pull
request title as the commit subject.

A pull request that moves an `exact`-lane byte pin needs its cause attributed
in the description and an entry in `BREAKING_CHANGES.md` before it merges.

## Release

Version Plans drive releases. After every successful `main` CI run with
pending plans, `release-pr.yml` regenerates the release commit through
`release:prepare --from-plans` as `tau-release-bot` and force-updates the
standing pull request on `release/next`; with none pending it closes the pull
request. Review it and squash-merge it with the title unchanged; that is the
entire release act. Do not push to `release/next` or enable auto-merge on it.

GitHub Actions owns npm OIDC publication, provenance, registry verification,
tags, and GitHub Releases. Do not publish from a workstation. The published
wasm pair is the one the release run built and tested.

Before the first release, all of these must hold:

- `release-pr.yml`, the `release:prepare` script and the `publish` and
  `registry-verify` jobs in `ci.yml` exist on `main`.
- The repository is public: npm provenance is not issued for private
  repositories.
- The `tau-cloud` stack is applied, so the `release-pr` environment holds the
  `tau-release-bot` credentials and the `main` ruleset requires `ci-gate`.

Manual fallback when the bot is broken: on a fresh branch off `main`, run
`pnpm release:prepare -- <version> --dry-run` and then the real run, commit
only generated release files as `chore(release): picovoxel v<version>`, and
open the pull request yourself.

## Registry administration

This repository publishes one package, `picovoxel`. The Tau plugin
`@taucad/picovoxel` is published from the Tau repository, not from here.

`picovoxel` has one npm Trusted Publisher: repository `taucad/picovoxel`,
workflow filename `ci.yml`, publish allowed, no environment. npm matches the
filename exactly; a provenance-signed publish that fails with `E404` means the
binding names another workflow. Audit it with `npm trust list picovoxel --json`
(npm 11.15.0 or newer, with account 2FA) and never replace a correct binding.
Publishing access on npmjs.com requires two-factor authentication and disallows
tokens; that is a site setting, and OIDC publication works under it.

The name was reserved with a manifest-only `0.0.0` placeholder published under
the `bootstrap` tag. npm also points `latest` at the first version of a new
package, so `latest` resolves to the placeholder until the first real release
moves it.

## Release recovery

npm publication is not transactional. Re-running the `publish` job of the same
workflow run is safe: it skips a version the registry already serves with the
candidate's integrity and fails on any other integrity. Never rebuild or amend a
published version; deprecate it and release a patch.

## Repository operations

The `tau-cloud` stack manages repository rules (squash-only merges titled from
the pull request, linear history, no force-push, `ci-gate` required), repository
auto-merge, read-only default workflow permissions, secret scanning, push
protection, private vulnerability reporting, and the `release-pr` environment.

Scheduled and event-driven maintenance:

- Dependabot opens weekly grouped updates for GitHub Actions and npm after a
  7-day cooldown. `dependabot-auto-merge.yml` enables auto-merge only for
  grouped patch updates and Actions updates, and it needs repository auto-merge
  and the required `ci-gate` check to complete.
- `osv-scan.yml` reports new advisories on pull requests without blocking them,
  and fails on `main` and in its weekly run. Suppressions in `osv-scanner.toml`
  carry a `reason` and an `ignoreUntil` timestamp. Its code-scanning upload runs
  only on a public repository.
- `bench.yml` runs monthly as a drift canary and never gates. `g0-nightly.yml`
  is manual while the repository is private; the public flip restores its
  nightly schedule (the cron line is in the file's header comment).
- `cache-cleanup.yml` deletes a pull request's Actions caches when it closes.

Scheduled failures open issues labelled `claude`. An issue opened by a workflow
does not start `claude.yml` (GitHub does not trigger workflows from events that
the workflow token creates); comment `@claude` on it to start the agent.
`claude.yml` runs immediately for owners, members and collaborators; other
requests wait for a maintainer's `/approve-claude` comment. It needs the
`ANTHROPIC_API_KEY` repository or organization secret.

Applying the `claude` label or commenting `@claude` is a maintainer approval,
the same as `/approve-claude`: Claude then acts on the issue's text, whoever
wrote it, with write access to the repository. Read an external issue for
injected instructions before labelling it.
