# Verifying releases

Every release archive on [GitHub Releases](https://github.com/piconic-ai/pedit/releases)
is built by this repository's release workflow on GitHub Actions and carries a
build provenance attestation, signed through Sigstore with the workflow's
identity. Releases are immutable once published.

## Check an archive yourself

With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify pedit_<version>_<os>_<arch>.tar.gz \
  --bundle pedit_<version>.sigstore.json \
  --repo piconic-ai/pedit \
  --signer-workflow piconic-ai/pedit/.github/workflows/release-build.yml
```

`pedit_<version>.sigstore.json` is published beside the archives from v0.1.6
on; with it, no GitHub sign-in is needed. For older releases, drop `--bundle`
and sign in with `gh auth login`. Releases up to v0.1.2 were signed by
`tagpr.yml` instead of `release-build.yml`.

## What the install scripts check

`install.sh` and `install.ps1` always compare the archive with
`checksums.txt`. When `gh` is installed they also run the check above, pinned
to the commit the release tag points to (`--source-digest` and
`--signer-digest`, looked up from the GitHub API; if that lookup fails they say
so and verify without the pin). Without `gh` they check only the checksum, and
say so.

The scripts themselves are served by the relay at `edit.piconic.ai`, so they
are only as trustworthy as the relay. To rely on the release workflow alone,
download an archive from GitHub and check it as above, or install with
Homebrew or `go install`.

## Rebuilding a release

The archives are reproducible: GoReleaser v2.18.3
(`goreleaser release --clean --skip=publish` with `.goreleaser.yaml`) run on
the same tag with the Go version from `go.mod` on `ubuntu-24.04` gives the same
`checksums.txt`. Releases made before the switch to GoReleaser were built by
`scripts/build-cli-release.sh`; their tags still carry it, so rebuild those
with that script instead.
