# Receipts, interruptions and generations

Read this when a run is still going, was interrupted, failed after acting, or
returned a resource handle.

## Receipt states

Every run is identified by its request id and leaves a receipt.

- `succeeded` — use the result, or its resource handle.
- `failed` — read the error. Correct the code only when no uncertain mutation
  is outstanding (see below).
- `running` — the body is still going in its task space. Read the receipt;
  **do not run the body again.**

```
browser_tasks {action: "receipt", task: "orders", request: "submit-order-03"}
```

The wait window is how long the tool call waits, not how long the body has. Its
expiry is not a failure.

## `mutation: possible`

A run that failed *after* acting reports `mutation: possible`. The action may
have happened. The procedure:

1. `browser_tasks {action: "checkpoint", task}` — the live URL, how many pages,
   whether the document is answering.
2. A `readOnly: true` run that inspects the application's own state: the order
   list, the row count, the confirmation banner. Read it with `innerText()`,
   `getAttribute()` and `count()` — `evaluate` is refused in a read-only run,
   because code you supply cannot be checked for whether it acts.
3. Continue from what you observed. Repeat the action only when the evidence
   shows it did not happen.

Never resolve the uncertainty by starting a fresh task and doing it again.

## Idempotent request ids

Ids that state intent and order:

```
open-dashboard-01
filter-breached-02
submit-escalation-03
verify-escalation-04
```

Calling `browser_task` again with `submit-escalation-03` and the same code
returns the existing receipt; it does not run anything. Never reuse an id for
changed code — that is refused, because the id is the identity of the
operation.

## Generations

Task spaces live in this page's memory. Reloading the harness starts a new
generation: the previous generation's tasks, pages and globals are gone. Naming
one of them again gets a task space that is new and empty, and the result
carries a `note` saying so — the machine writes the names down before the
reload so that it can tell you rather than let you find out halfway through the
next body. `browser_tasks {action: "list"}` prints the current generation.

If that happens while a mutation was outstanding, treat it exactly as
`mutation: possible` — but note that a new task space has no page, and a
`readOnly` run cannot open one, because `goto()` changes what the tab is
showing. So the look comes first and separately:

1. `browser_navigate {url}` to put the page back on screen. This opens a tab;
   it does not act on the application.
2. `browser_inspect` — no task space, no slot spent — or, if you need a loop,
   `browser_task {task, readOnly: true, claimTab: "<the tab id>", code}`.
   `claimTab` is what gives a read-only run a page to read.

Repeat the action only against evidence.

## Large results

Prefer returning an aggregate. When a result comes back as a resource:

1. `browser_tasks {action: "resource", task, resource: "res-…", offset: 0}`
2. Append the slice, continue from the `nextOffset` it reports.
3. Stop when it says that is all of it.

A slice is 8192 bytes unless you ask for more with `maxBytes`, which goes up to
65536. Do not echo a whole resource into an answer when a summary is what was
asked for — and consider `saveFile()` instead, which turns the result into a
file the user can open.

## Cleaning up

```
browser_tasks {action: "finish", task: "orders"}
```

Once, after verification, or when abandoning a failed task. It closes the pages
the task opened and leaves any tab you were given with `claimTab` alone. Pass
`keep: true` only when the pages are something for the user to look at.
