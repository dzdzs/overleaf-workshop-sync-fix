# Patch set

Base version: [`overleaf-workshop/overleaf-workshop` v0.15.10](https://github.com/overleaf-workshop/overleaf-workshop/releases/tag/v0.15.10)

## Fixed behavior

- Route `undici` HTTP requests through `HTTP_PROXY`, `HTTPS_PROXY`, and
  `NO_PROXY` with `EnvHttpProxyAgent`.
- Route legacy Socket.IO handshake and WebSocket traffic through the same proxy
  environment using `http-proxy-agent`, `https-proxy-agent`, and
  `proxy-from-env`.
- Find `.overleaf/settings.json` by walking upward from the active LaTeX file,
  so a replica can live below the workspace root.
- Recover a local replica association from `.overleaf/settings.json` when the
  extension's global SCM record is missing.
- Persist replica locations as normalized file URIs and correctly dispose their
  watchers during reconnects.
- Detect files changed by terminals, Git, and coding agents with both the VS
  Code file watcher and a 1.5 second metadata poll.
- Join a remote document before writing it. This initializes the version and
  text caches required to construct the Overleaf OT update.
- Avoid blocking connection setup on a full project replay, which can exceed
  the collaboration API timeout.

## Build

```bash
npm ci
cd views/chat-view && npm ci && cd ../..
npm run compile
npm run lint
npx @vscode/vsce package
```

Install the resulting VSIX from the editor's **Extensions: Install from VSIX**
command.

## Verification

The source compiles with TypeScript and passes ESLint without errors. The
installed patch was also tested against an Overleaf project by:

1. changing a `.tex` file from a terminal;
2. waiting for the local replica poller;
3. downloading the project ZIP independently from Overleaf;
4. comparing the local and remote file sizes and SHA-256 hashes;
5. restoring the original file and repeating the comparison.

Both upload and restoration produced byte-identical local and remote files.
No session cookie, GitHub token, or project credential is stored in this
repository.
