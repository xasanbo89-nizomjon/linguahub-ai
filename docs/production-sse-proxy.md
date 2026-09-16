# SSE (Server-Sent Events) Behind a Reverse Proxy (Phase 11)

`POST /api/chat/stream` streams the AI response as `text/event-stream`
(unchanged since Phase 1) - real chunks written via `res.write("data:
...\n\n")` as they arrive from OpenAI, ending with `data: [DONE]\n\n`. A
reverse proxy sitting in front of this backend in production **must** be
configured not to buffer or cache this response, or streaming silently
degrades into "wait for the whole answer, then get it all at once" - the
response would still eventually arrive, but the real-time typing effect
(and the ability to Stop mid-generation) would be lost.

## What `server.js` already sends (application-side, real today)

| Header | Value | Purpose |
|---|---|---|
| `Content-Type` | `text/event-stream` | Standard SSE content type |
| `Cache-Control` | `no-cache` | Tells any cache (browser, CDN, proxy) not to cache the stream |
| `Connection` | `keep-alive` | Keeps the underlying connection open for the duration of the stream |
| `X-Accel-Buffering` | `no` | **Nginx's own documented opt-out signal** for response buffering - see below |

Verified live: `tests/server-production.test.js`, "a streamed chat
response sets the SSE headers a reverse proxy needs to respect."

## What the reverse proxy itself must additionally be configured to do

Response headers alone cannot force a proxy's own buffering/caching
behavior - `X-Accel-Buffering: no` specifically is Nginx's mechanism for
this (Nginx recognizes and honors that header automatically), but the
proxy's own config is still what actually applies it, and other proxy
software may need explicit configuration instead of (or in addition to)
honoring a response header. See `docs/nginx-example.conf` for a complete,
concrete Nginx example implementing everything below.

- **Disable response buffering** for this route specifically (Nginx:
  `proxy_buffering off;`) - the single most important setting; without it,
  Nginx accumulates the entire response before forwarding any of it.
- **Disable proxy caching** for this route (`proxy_cache off;` if caching
  is enabled anywhere upstream of this - unlikely for a POST request by
  default, but explicit is safer than assumed).
- **Increase the proxy's own read timeout** beyond the longest AI mode
  timeout (`lib/aiModes.js`'s Deep Thinking mode: 90 seconds) - a proxy's
  default read/response timeout (often 60s) would otherwise cut the
  connection before this app's own timeout has a chance to send its own
  honest "took too long" error event.
- **Forward the real client IP** (`X-Forwarded-For`/`X-Real-IP`) - required
  for `TRUST_PROXY`-aware rate limiting to key by the real client, not the
  proxy's own address (`docs/production-network-and-cors.md`).
- **Preserve `Connection: keep-alive` / HTTP/1.1** to the upstream - some
  proxy defaults force `Connection: close` upstream, which would
  needlessly tear down and re-establish a connection per request.
- **No compression on this route** - gzip/brotli compression buffers
  output to build compressible chunks, which defeats real-time streaming
  the same way response buffering does. `server.js` does not apply
  compression itself (no `compression` middleware is used anywhere in
  this project); a reverse proxy or CDN sitting in front of it must not
  add it for this route either.

## Abort propagation

If the client disconnects mid-stream (closes the tab, network drops),
`server.js`'s `res.on("close", ...)` handler already fires and aborts the
upstream OpenAI request via `AbortController` (unchanged since before this
phase) - this stops billing/consuming tokens for a response nobody is
listening to anymore. A reverse proxy that buffers the response would
delay or prevent this signal from ever reaching the application (the
proxy itself would still be "connected" to the backend even after the
real client vanished, holding the connection open needlessly) - another
reason `proxy_buffering off` matters specifically for this route.

## No duplicated chunks, graceful disconnect

Each `res.write()` call emits exactly one `data: {...}\n\n` frame; nothing
in this app retries or replays a chunk. A graceful client disconnect (tab
closed normally) and an ungraceful one (network drop) both land in the
same `res.on("close")` path - the abort behavior is identical either way,
by design (this app cannot distinguish the two, and doesn't need to).

## Local proxy simulation

Not performed this phase - a real reverse-proxy process (Nginx or
equivalent) is not part of this project's existing tooling, and standing
one up would be exactly the kind of "add real infrastructure" this
phase's rules caution against introducing without clear justification. The
SSE headers this application sends were instead verified directly
(`tests/server-production.test.js`), and the proxy-side configuration
required to respect them is documented precisely in
`docs/nginx-example.conf` for whoever configures the real reverse proxy
at deploy time.
