# Patch set

Base version: [`overleaf-workshop/overleaf-workshop` v0.15.10](https://github.com/overleaf-workshop/overleaf-workshop/releases/tag/v0.15.10)

## Fixed behavior

- Route `undici` HTTP requests through `HTTP_PROXY`, `HTTPS_PROXY`, and
  `NO_PROXY` with `EnvHttpProxyAgent`.
- Route legacy Socket.IO handshake and WebSocket traffic through the same proxy
  environment using `http-proxy-agent`, `https-proxy-agent`, and
  `proxy-from-env`.
- Refresh and replace Overleaf's short-lived Socket.IO cookie when the legacy
  v1 join request times out, then reconnect through the project-scoped v2
  endpoint. The long-lived login session can remain valid after this secondary
  cookie expires.
- Find `.overleaf/settings.json` by walking upward from the active LaTeX file,
  so a replica can live below the workspace root.
- Recover a local replica association from `.overleaf/settings.json` when the
  extension's global SCM record is missing.
- Match the settings URI to the active Overleaf project when one parent
  workspace contains several local replicas.
- Persist replica locations as normalized file URIs and correctly dispose their
  watchers during reconnects.
- Detect files changed by terminals, Git, and coding agents with both the VS
  Code file watcher and a 1.5 second metadata poll.
- Reconcile local files when the replica reconnects so edits made while the
  extension host was stopped are uploaded after the next window reload.
- Join a remote document before writing it. This initializes the version and
  text caches required to construct the Overleaf OT update.
- Create remote documents for newly added local files instead of aborting when
  the pre-write document join reports that the remote path does not exist.
- Preserve the multipart boundary and content length when uploading new files
  through `undici`, so Overleaf receives the `qqfile` form part.
- Create new local-replica files through the authenticated HTTP API using the
  last loaded file tree, without waiting for a reconnecting OT socket.
- Await each replica operation during reconciliation to avoid flooding the
  collaboration socket with concurrent document joins after reconnecting.
- Dispose replaced collaboration status timers during reconnects so stale
  managers do not keep reporting a disconnected state.
- Replace a nominally connected Socket.IO session when `joinDoc` stops
  acknowledging requests, refresh its short-lived cookie, and retry over v2.
- Serialize local-replica events, retry failed file signatures, and share one
  recovery across requests that time out on the same collaboration socket.
- Push existing local-replica documents through an isolated project-scoped v2
  connection that refreshes its short-lived cookie and disconnects after the OT
  update, so background synchronization does not depend on a stale editor socket.
- Persist successful local file signatures under `.overleaf` and compare them on
  startup, replaying offline edits without opening every project document after
  each extension-host restart.
- Filter empty Unicode diff components and verify committed content through a
  fresh collaboration connection before recording success.
- Preserve failed changes for polling retries and defer remote pulls while a local
  push is pending, preventing a rejected OT update from overwriting the local edit.
- Force durable polling changes through a real remote write and fresh verification,
  even when an earlier watcher event populated the propagation cache.
- Reconcile the most recently modified local files first and stop reconciliation
  tasks whose local-replica provider was replaced during a reconnect.
- Avoid blocking connection setup on a full project replay, which can exceed
  the collaboration API timeout.
- Replay a remote change notification skipped while a local push held its
  path, once that push settles, instead of dropping it. Previously a pending
  or failed local push silently discarded any concurrent Overleaf edit to the
  same file, so it never reached the local replica or the next push's base
  content.

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
