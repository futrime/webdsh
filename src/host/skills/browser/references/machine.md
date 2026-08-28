# This machine

What the browser machine is, so the differences from a desktop browser are
predictable rather than surprising.

## Where a page lives

Every tab is an `<iframe>` sandboxed *without* `allow-same-origin`, which gives
it an opaque origin. That is the isolation, and it is the browser's own rule
rather than a promise this build makes: a page cannot reach the harness, its
storage, or the user's keys, and every attempt comes back `SecurityError`.

The cost is that the frame has no network and no storage of its own. Every byte
it sees was fetched by the page around it, rewritten, and handed over; every
cookie and every `localStorage` key it writes is stored on this side. A nested
frame inside a page is another opaque origin again, with its own copy of the
runtime, which is why frames are addressed by name rather than reached into.

## Where task code lives

`browser_task` code runs in a *third* place: a sandboxed frame of its own, also
opaque-origin, holding nothing of the harness. It cannot read this page's
storage or its keys either. Everything it does — clicking, reading, fetching,
writing a file — is a request to the machine, and the machine does only the
things it knows how to do.

That is why the API is asynchronous everywhere: it is a real boundary, not a
convention.

## What that costs

- **No logins.** No request carries a cookie (`Cookie` is a forbidden header
  for a page) and no `set-cookie` comes back (CORS does not expose it).
- **Most hosts need the CORS proxy**, which is a third party that sees the whole
  request. Settings → Network is where it is configured. Never send a credential
  through this machine.
- **Dialogs are answered from a policy** armed before they are raised, because a
  synchronous `confirm()` cannot be paused from outside the frame — measured:
  this page is not cross-origin isolated inside a sandboxed frame, so there is
  no `SharedArrayBuffer` to block on either.
- **No WebSockets, no IndexedDB, no Cache API.** Sites fall back to
  `localStorage`, which works.
- **Screenshots are drawn from the DOM** by the browser's own renderer. Text and
  layout are accurate; a nested frame, a plugin and video are not drawn.

## What it costs the user

Tabs are 1280×800 and the user can watch them in the Machine panel, so what you
click, they see. The profile is this machine's own: it starts empty, it persists
between sessions, and it has nothing in common with the user's real browser.
