# Public research reader: operating boundary

## Runtime decision and cost (before implementation)

Use maintained `playwright` Chromium APIs, `cheerio` for inert document parsing,
and `ipaddr.js` for public-address classification. Chromium is an optional local
runtime, not a remote automation provider. Do not install a remote browser service.
The Node dependencies are required; the Chromium executable and OS sandbox are
checked separately. Rendering costs a browser process per active read (startup,
CPU and memory); plan at least 512 MiB headroom per slot and measure in the target
runtime before enabling. Default shared concurrency is one, hard ceiling two.
No additional rendering-provider fee; ordinary search-provider costs are unchanged.

On NixOS the adapter prefers the fixed managed `/repl/tools/bin/chromium`
wrapper when present (it supplies native libraries); otherwise it uses the
matching Playwright-installed build. Neither path accepts request-supplied
executables, flags or environment. Both require the Chromium OS sandbox.

## Enforceable design

Chromium never navigates to the Internet. Node retrieves each approved public
document using a DNS-validated, connection-pinned socket, no credentials, no
cookies, no proxy inheritance and no automatic redirects. Each redirect is
revalidated. Only inert text/heading/table markup is passed into the fresh,
sandboxed, anonymous, offline Chromium context. All browser requests are aborted;
scripts, service workers, downloads, frames, popups, forms, external styles and
storage are unavailable. No model-provided JavaScript, selector, click, shell or
write operation is supported. Fixed application extraction code is not a model
execution API. No private files or application data are passed to the browser.

This deliberately trades live-page fidelity for enforceable network isolation.
Script-dependent rendering has **no approved policies** in this release. Login,
CAPTCHA, paywall, JS-only and uncertain destinations fail explicitly. This is not
a general browser agent. A page visit is retrieval, not verification.

Only HTTP(S) on standard ports, no credentials, no query strings, no fragment
actions, and reviewed reading-route shapes are accepted. Unknown paths are
unsupported, not assumed safe. Sites may log requests; even GET can have server
side effects. Strict read-only semantics cannot be guaranteed on third-party
servers, including approved reading routes.

The playground owns request-local evidence and budgets, not a global page cache.
Search remains first for discovery; direct document extraction precedes optional
offline rendering. Source following is an explicit validated URL selected from
previously extracted links, not a click or recursive crawler.

## Limits and rollout

Per request: 3 documents, 2 source-following hops, 45 seconds of reader work
(including queueing and transfer), 2 scroll passes per rendered document,
2 MiB per document, 30,000 evidence characters total. A shared small concurrency
cap rejects excess work rather than creating an unbounded queue. Stop/disconnect
aborts sockets and closes rendering resources. No persistent browser profiles.

Before enabling rendering in any target runtime, install a supported Playwright
Chromium build with its OS libraries, confirm sandbox support, and run the reader
runtime check and deterministic safety tests there. Never use `--no-sandbox`.
If sandboxed Chromium is unavailable, direct reading still works and rendering
returns an explicit runtime limitation. Do not claim a development executable
exists in published instances. Deployment is a separate operator decision.
