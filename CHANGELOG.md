# Changelog

## [v0.1.14](https://github.com/piconic-ai/pedit/compare/v0.1.13...v0.1.14) - 2026-10-21

- Check cognitive complexity in CI with cccc by @kfly8 in https://github.com/piconic-ai/pedit/pull/185
- Split the heaviest CLI functions into named steps by @kfly8 in https://github.com/piconic-ai/pedit/pull/186
- Split the heaviest TypeScript functions into named steps by @kfly8 in https://github.com/piconic-ai/pedit/pull/188
- Split the heaviest internal Go functions into named steps by @kfly8 in https://github.com/piconic-ai/pedit/pull/189
- Lower the cognitive complexity limit to 20 by @kfly8 in https://github.com/piconic-ai/pedit/pull/190
- Make two tests hold on busy machines and as root by @kfly8 in https://github.com/piconic-ai/pedit/pull/187

## [v0.1.13](https://github.com/piconic-ai/pedit/compare/v0.1.12...v0.1.13) - 2026-10-20

- Log why a room's session ended by @kfly8 in https://github.com/piconic-ai/pedit/pull/180
- Wait for a host that drops instead of closing the room by @kfly8 in https://github.com/piconic-ai/pedit/pull/182
- Check that the room itself still holds the CLI's connection by @kfly8 in https://github.com/piconic-ai/pedit/pull/183

## [v0.1.12](https://github.com/piconic-ai/pedit/compare/v0.1.11...v0.1.12) - 2026-10-20

- Note CodePen's human check in the embeds doc by @kfly8 in https://github.com/piconic-ai/pedit/pull/169
- Check shared paths the same way in Go and TypeScript by @kfly8 in https://github.com/piconic-ai/pedit/pull/171
- Sync several files in one room, each in a doc of its own by @kfly8 in https://github.com/piconic-ai/pedit/pull/172
- Share several files from the host, and add more while sharing by @kfly8 in https://github.com/piconic-ai/pedit/pull/173
- Switch between a room's files in the editor by @kfly8 in https://github.com/piconic-ai/pedit/pull/174
- Mirror a room's other files when joining from the command line by @kfly8 in https://github.com/piconic-ai/pedit/pull/175
- Document sharing several files in one room by @kfly8 in https://github.com/piconic-ai/pedit/pull/176
- Name a command line guest's copies itself, in one temporary directory by @kfly8 in https://github.com/piconic-ai/pedit/pull/178
- Reconnect the CLI when its connection dies without a close by @kfly8 in https://github.com/piconic-ai/pedit/pull/179

## [v0.1.11](https://github.com/piconic-ai/pedit/compare/v0.1.10...v0.1.11) - 2026-10-19

- Make the busy-relay room test robust on slow runners by @kfly8 in https://github.com/piconic-ai/pedit/pull/167
- Embed CodePen team pens by @kfly8 in https://github.com/piconic-ai/pedit/pull/166

## [v0.1.10](https://github.com/piconic-ai/pedit/compare/v0.1.9...v0.1.10) - 2026-10-19

- Embed GitHub source files in the preview by @kfly8 in https://github.com/piconic-ai/pedit/pull/164

## [v0.1.9](https://github.com/piconic-ai/pedit/compare/v0.1.8...v0.1.9) - 2026-10-19

- Define embed providers as files in a build-time registry by @kfly8 in https://github.com/piconic-ai/pedit/pull/157
- Load preview embeds only when someone clicks them by @kfly8 in https://github.com/piconic-ai/pedit/pull/158
- Let people always load the preview players of chosen providers by @kfly8 in https://github.com/piconic-ai/pedit/pull/159
- Embed Loom, Figma, CodePen, StackBlitz, Observable, Spotify, SoundCloud and Miro by @kfly8 in https://github.com/piconic-ai/pedit/pull/161

## [v0.1.8](https://github.com/piconic-ai/pedit/compare/v0.1.7...v0.1.8) - 2026-10-18

- Say that pedit checks the configuration file's owner on Windows too by @kfly8 in https://github.com/piconic-ai/pedit/pull/154
- Build CLI release archives with GoReleaser by @kfly8 in https://github.com/piconic-ai/pedit/pull/156

## [v0.1.7](https://github.com/piconic-ai/pedit/compare/v0.1.6...v0.1.7) - 2026-10-16

- Keep a peer from crashing the host with canvas values JSON cannot hold by @kfly8 in https://github.com/piconic-ai/pedit/pull/146
- Keep the blob route from admitting anyone as the room's host by @kfly8 in https://github.com/piconic-ai/pedit/pull/147
- Check who owns the configuration file on Windows too by @kfly8 in https://github.com/piconic-ai/pedit/pull/149
- Check a canvas node's string fields whatever its type by @kfly8 in https://github.com/piconic-ai/pedit/pull/150
- Keep names and replies from others out of the terminal and the shell by @kfly8 in https://github.com/piconic-ai/pedit/pull/151
- Number frames so the relay cannot replay them by @kfly8 in https://github.com/piconic-ai/pedit/pull/152

## [v0.1.6](https://github.com/piconic-ai/pedit/compare/v0.1.5...v0.1.6) - 2026-10-15

- Note the MEDIA_SOURCES change for self-hosted relays in the v0.1.5 changelog by @kfly8 in https://github.com/piconic-ai/pedit/pull/133
- Redirect plain HTTP to HTTPS and send HSTS by @kfly8 in https://github.com/piconic-ai/pedit/pull/135
- Run OpenSSF Scorecard and add badges to the README by @kfly8 in https://github.com/piconic-ai/pedit/pull/137
- Add Go fuzz tests for what peers can send, and a weekly fuzz job by @kfly8 in https://github.com/piconic-ai/pedit/pull/138
- Harden CI: least-privilege tokens, CodeQL and Dependabot by @kfly8 in https://github.com/piconic-ai/pedit/pull/139
- Attach the build provenance to each Release as files by @kfly8 in https://github.com/piconic-ai/pedit/pull/140
- Raise the sharp override to 0.35.5 for GHSA-wq5f-xc86-pv6w by @kfly8 in https://github.com/piconic-ai/pedit/pull/144
- Bump the go-minor-and-patch group across 1 directory with 3 updates by @dependabot[bot] in https://github.com/piconic-ai/pedit/pull/141
- Bump the actions group across 1 directory with 3 updates by @dependabot[bot] in https://github.com/piconic-ai/pedit/pull/142
- Show the settings popover as open in its tests, for jsdom 30.1.2 by @kfly8 in https://github.com/piconic-ai/pedit/pull/145
- Bump the npm-minor-and-patch group across 1 directory with 15 updates by @dependabot[bot] in https://github.com/piconic-ai/pedit/pull/143

## [v0.1.5](https://github.com/piconic-ai/pedit/compare/v0.1.4...v0.1.5) - 2026-10-15

- Add a Content-Security-Policy to the editor, set by the Worker by @kfly8 in https://github.com/piconic-ai/pedit/pull/131

**Self-hosted relays:** the Markdown preview no longer loads external images and videos by default. To allow them, set `MEDIA_SOURCES` (for example `https:`); see [docs/self-hosting.md](docs/self-hosting.md).

## [v0.1.4](https://github.com/piconic-ai/pedit/compare/v0.1.3...v0.1.4) - 2026-10-15

- Build pedit with a supported Go release by @kfly8 in https://github.com/piconic-ai/pedit/pull/126
- End public-relay rooms after 24 hours, and clean up rooms whose host is gone by @kfly8 in https://github.com/piconic-ai/pedit/pull/128
- Name the public relay's abuse contact by @kfly8 in https://github.com/piconic-ai/pedit/pull/129

## [v0.1.3](https://github.com/piconic-ai/pedit/compare/v0.1.2...v0.1.3) - 2026-10-14

- Refuse files too large to share, and document the security design and the public relay by @kfly8 in https://github.com/piconic-ai/pedit/pull/123
- Build release archives reproducibly in a separate signed workflow by @kfly8 in https://github.com/piconic-ai/pedit/pull/125

## [v0.1.2](https://github.com/piconic-ai/pedit/compare/v0.1.1...v0.1.2) - 2026-10-13

- Fix four local-file issues: config link crash, lost concurrent saves, silent save failures, umask by @kfly8 in https://github.com/piconic-ai/pedit/pull/119

## [v0.1.1](https://github.com/piconic-ai/pedit/compare/v0.1.0...v0.1.1) - 2026-10-12

- Record the zone's minimum TLS version, set to 1.2 on Cloudflare by @kfly8 in https://github.com/piconic-ai/pedit/pull/110
- Document what pedit does on your computer, and keep it in bounds by @kfly8 in https://github.com/piconic-ai/pedit/pull/112

## [v0.1.0](https://github.com/piconic-ai/pedit/compare/v0.0.13...v0.1.0) - 2026-10-07

- Add a security policy by @kfly8 in https://github.com/piconic-ai/pedit/pull/95
- Check the protocol version on connect and ask outdated clients to update by @kfly8 in https://github.com/piconic-ai/pedit/pull/103
- Reject browser WebSockets from other origins by @kfly8 in https://github.com/piconic-ai/pedit/pull/105
- Bound what one room can cost on the public relay by @kfly8 in https://github.com/piconic-ai/pedit/pull/104
- Rate limit new rooms and connections per network by @kfly8 in https://github.com/piconic-ai/pedit/pull/106
- Add a maintenance mode in two levels by @kfly8 in https://github.com/piconic-ai/pedit/pull/107

## [v0.0.13](https://github.com/piconic-ai/pedit/compare/v0.0.12...v0.0.13) - 2026-10-06

- Show install progress with cycling dots by @kfly8 in https://github.com/piconic-ai/pedit/pull/90
- Tell the user when a newer pedit is released by @kfly8 in https://github.com/piconic-ai/pedit/pull/92
- Name the service pedit everywhere it is shown by @kfly8 in https://github.com/piconic-ai/pedit/pull/93
- Move the module and links to piconic-ai/pedit by @kfly8 in https://github.com/piconic-ai/pedit/pull/94

## [v0.0.12](https://github.com/piconic-ai/edit/compare/v0.0.11...v0.0.12) - 2026-10-06

- Show the Come over film at the top of the README by @kfly8 in https://github.com/piconic-ai/edit/pull/85
- Fix image link in README.md by @kfly8 in https://github.com/piconic-ai/edit/pull/87
- Attest build provenance of the release archives by @kfly8 in https://github.com/piconic-ai/edit/pull/88
- Add an install script served from edit.piconic.ai by @kfly8 in https://github.com/piconic-ai/edit/pull/89

## [v0.0.11](https://github.com/piconic-ai/edit/compare/v0.0.10...v0.0.11) - 2026-10-05

- Preserve adjacent image references in authorization baselines by @kfly8 in https://github.com/piconic-ai/edit/pull/83

## [v0.0.10](https://github.com/piconic-ai/edit/compare/v0.0.9...v0.0.10) - 2026-10-05

- Prevent symlink redirection of atomic document saves by @kfly8 in https://github.com/piconic-ai/edit/pull/73
- Require room admission before allocating relay resources by @kfly8 in https://github.com/piconic-ai/edit/pull/74
- Keep new document copies and attachments private by @kfly8 in https://github.com/piconic-ai/edit/pull/75
- Bind shared file I/O to its original directory by @kfly8 in https://github.com/piconic-ai/edit/pull/78
- Restrict attachment resends to host-authorized images by @kfly8 in https://github.com/piconic-ai/edit/pull/79
- Reject room creation redirects carrying Access credentials by @kfly8 in https://github.com/piconic-ai/edit/pull/80
- Update audited dependencies and record remediation by @kfly8 in https://github.com/piconic-ai/edit/pull/81

## [v0.0.9](https://github.com/piconic-ai/edit/compare/v0.0.8...v0.0.9) - 2026-10-04

- Join a room from the command line to edit its copy in any editor by @kfly8 in https://github.com/piconic-ai/edit/pull/71

## [v0.0.8](https://github.com/piconic-ai/edit/compare/v0.0.7...v0.0.8) - 2026-10-03

- Link the editor brand to the landing page as pedit by @kfly8 in https://github.com/piconic-ai/edit/pull/68
- Render Markdown frontmatter as structured metadata by @kfly8 in https://github.com/piconic-ai/edit/pull/70

## [v0.0.7](https://github.com/piconic-ai/edit/compare/v0.0.6...v0.0.7) - 2026-10-02

- Show pair editing on the landing page by @kfly8 in https://github.com/piconic-ai/edit/pull/66

## [v0.0.6](https://github.com/piconic-ai/edit/compare/v0.0.5...v0.0.6) - 2026-10-02

- Add project configuration and reusable file templates by @kfly8 in https://github.com/piconic-ai/edit/pull/63
- Simplify configuration and template documentation by @kfly8 in https://github.com/piconic-ai/edit/pull/65

## [v0.0.5](https://github.com/piconic-ai/edit/compare/v0.0.4...v0.0.5) - 2026-10-01

- Refresh README and add one-click self-host deployment by @kfly8 in https://github.com/piconic-ai/edit/pull/57
- fix: select the maintainer Wrangler config explicitly by @kfly8 in https://github.com/piconic-ai/edit/pull/59
- Isolate the Cloudflare deploy button server workspace by @kfly8 in https://github.com/piconic-ai/edit/pull/60
- Make shared-link recovery guidance gentler by @kfly8 in https://github.com/piconic-ai/edit/pull/61
- Automate Homebrew formula updates after pedit releases by @kfly8 in https://github.com/piconic-ai/edit/pull/62

## [v0.0.4](https://github.com/piconic-ai/edit/compare/v0.0.3...v0.0.4) - 2026-10-01

- feat: include pedit binaries in GitHub releases by @kfly8 in https://github.com/piconic-ai/edit/pull/56

## [v0.0.3](https://github.com/piconic-ai/edit/compare/v0.0.2...v0.0.3) - 2026-09-30

- Try ima behind Cloudflare Access on an ima-lab Worker by @kfly8 in https://github.com/piconic-ai/edit/pull/9
- Sign in to Cloudflare Access with cloudflared, and speak plainly by @kfly8 in https://github.com/piconic-ai/edit/pull/19
- Pick the editor language from the file extension by @kfly8 in https://github.com/piconic-ai/edit/pull/18
- Add Vim keybindings to the browser editor by @kfly8 in https://github.com/piconic-ai/edit/pull/21
- Add a Markdown preview pane with images and videos by @kfly8 in https://github.com/piconic-ai/edit/pull/22
- Start a room on a scratch file when ima runs without a file by @kfly8 in https://github.com/piconic-ai/edit/pull/25
- Explain why a file cannot be shared, suggesting close names by @kfly8 in https://github.com/piconic-ai/edit/pull/26
- Let readers pick the editor theme, page scheme and text settings by @kfly8 in https://github.com/piconic-ai/edit/pull/27
- Fix Tab and last-line dd/p in Vim mode by @kfly8 in https://github.com/piconic-ai/edit/pull/28
- Make the editor usable on phones by @kfly8 in https://github.com/piconic-ai/edit/pull/29
- Colour the whole page in one theme, picked from a gallery by @kfly8 in https://github.com/piconic-ai/edit/pull/30
- Edit CSV and TSV files as a table by @kfly8 in https://github.com/piconic-ai/edit/pull/31
- Build the web UI with BarefootJS, starting with the ended banner by @kfly8 in https://github.com/piconic-ai/edit/pull/33
- Move the header to a BarefootJS component by @kfly8 in https://github.com/piconic-ai/edit/pull/34
- Finish moving the web UI to BarefootJS (settings, table, menu, layout), with #32 by @kfly8 in https://github.com/piconic-ai/edit/pull/35
- Make the table look and work more like a spreadsheet by @kfly8 in https://github.com/piconic-ai/edit/pull/32
- Read stores as signals in components, and stop republishing unchanged peers by @kfly8 in https://github.com/piconic-ai/edit/pull/36
- Reconfigure the reader theme so line height changes remeasure the gutter by @kfly8 in https://github.com/piconic-ai/edit/pull/37
- Remove the Font (Monospace/Proportional) setting by @kfly8 in https://github.com/piconic-ai/edit/pull/38
- Add attachment messages and blob encryption to the protocol by @kfly8 in https://github.com/piconic-ai/edit/pull/39
- Store encrypted attachments in R2 while the host is connected by @kfly8 in https://github.com/piconic-ai/edit/pull/40
- Save pasted images beside the file on the host by @kfly8 in https://github.com/piconic-ai/edit/pull/41
- Paste and drop images into the editor by @kfly8 in https://github.com/piconic-ai/edit/pull/42
- Show images added during the session in the preview by @kfly8 in https://github.com/piconic-ai/edit/pull/43
- Move to BarefootJS 0.39.1 and drop the workarounds it made unnecessary by @kfly8 in https://github.com/piconic-ai/edit/pull/49
- Read and write JSON Canvas files as shared structure by @kfly8 in https://github.com/piconic-ai/edit/pull/45
- Share a .canvas as nodes and edges by @kfly8 in https://github.com/piconic-ai/edit/pull/46
- Show a canvas room as a board to edit together by @kfly8 in https://github.com/piconic-ai/edit/pull/48
- Edit a canvas as JSON beside the board by @kfly8 in https://github.com/piconic-ai/edit/pull/50
- Show others on a canvas: what they select, type in and drag by @kfly8 in https://github.com/piconic-ai/edit/pull/51
- Canvas: edges with square bends, and a visible caret on dark themes by @kfly8 in https://github.com/piconic-ai/edit/pull/52
- ci: use Codex Terra for Pullfrog by @kfly8 in https://github.com/piconic-ai/edit/pull/53
- chore: rename ima to piconic edit by @kfly8 in https://github.com/piconic-ai/edit/pull/54

## [v0.0.2](https://github.com/piconic-ai/edit/compare/v0.0.1...v0.0.2) - 2026-09-25

- Close a room as soon as its host leaves by @kfly8 in https://github.com/piconic-ai/edit/pull/4
- chore: add Pullfrog workflow file by @pullfrog[bot] in https://github.com/piconic-ai/edit/pull/6
- Rewrite the CLI in Go by @kfly8 in https://github.com/piconic-ai/edit/pull/7
- Explain why a room could not be created by @kfly8 in https://github.com/piconic-ai/edit/pull/8

## [v0.0.1](https://github.com/piconic-ai/edit/commits/v0.0.1) - 2026-09-24

- Build the minimal version of pedit by @kfly8 in https://github.com/piconic-ai/edit/pull/1
- License under MIT and ship third-party licenses by @kfly8 in https://github.com/piconic-ai/edit/pull/3
