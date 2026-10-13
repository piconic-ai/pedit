# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/piconic-ai/pedit/security/advisories/new).
Do not open a public issue, pull request or discussion for a suspected
vulnerability.

Include what you can of:

- the affected component (CLI, relay, browser editor) and pedit version or commit
- steps to reproduce, or a proof of concept
- the impact you expect, such as which party learns or changes what

Do not include real room links, keys, admission tokens, Access tokens or private
document content. Use a room you created for the test, and replace any key with
a placeholder.

## Supported versions

pedit is pre-1.0. Fixes go into `main` and ship in the next release; older
releases are not patched. The public relay at `edit.piconic.ai` runs the latest
release and is in scope.

| Version             | Supported |
| ------------------- | --------- |
| Latest release      | Yes       |
| `main`              | Yes       |
| Older releases      | No        |

## Scope

pedit's trust model is described in
[privacy and security](README.md#privacy-and-security) and
[security design](docs/security-design.md), and what the CLI reads, writes
and runs in [what pedit does on your computer](docs/local-files.md).
Issues that break it are in scope, for example:

- the room key, plaintext or decrypted attachments reaching the relay, its logs
  or any third party
- joining a room, or reading or writing its encrypted attachments, without the
  key in the link
- tampering with document updates or attachments that clients accept without
  noticing
- the CLI writing outside the intended file or directory, or exposing local files
- release archives, the install script or the Homebrew formula not matching what
  this repository's release workflow built

The following are expected behavior and out of scope:

- anyone holding the full link reading and editing the room
- a modified editor, malicious relay operator or compromised participant device
  reading the key or plaintext
- metadata visible to infrastructure: IP addresses, room IDs, request timing and
  ciphertext sizes
- requests that Markdown previews or Access avatars make to external hosts
- a `.pedit/config.yaml` that came with a repository you run pedit in choosing
  the relay, or the share link being visible in a guest's command line
- misconfiguration of a self-hosted deployment
- denial of service through traffic volume against the public relay

## What to expect

- We acknowledge your report within 3 business days.
- We send an initial assessment within 7 days, and keep you updated until the
  issue is resolved.
- Once a fix is released, we publish a GitHub Security Advisory (with a CVE when
  it applies) and credit you, unless you prefer otherwise.
- We ask you to keep the issue private until the advisory is published, or for
  90 days from your report, whichever comes first. If we need longer, we will
  discuss it with you.

## Testing guidelines

Test only against rooms you created, or against your own
[self-hosted](README.md#self-host) deployment. Do not access other people's
rooms or data, and do not run load or denial of service tests against
`edit.piconic.ai`. We will not pursue good-faith research that follows this
policy.
