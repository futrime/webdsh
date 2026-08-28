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
   list, the row count, the confirmation banner.
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
generation: the previous generation's tasks, pages and globals are gone, and a
call naming one fails with `GENERATION_MISMATCH` rather than quietly starting
over. `browser_tasks {action: "list"}` prints the current generation.

If that happens while a mutation was outstanding, treat it exactly as
`mutation: possible`: inspect first, in a new task, read-only, and repeat only
against evidence.

## Large results

Prefer returning an aggregate. When a result comes back as a resource:

1. `browser_tasks {action: "resource", task, resource: "res-…", offset: 0}`
2. Append the slice, continue from the `nextOffset` it reports.
3. Stop when it says that is all of it.

Slices are at most 8192 bytes and the server chooses the length. Do not echo a
whole resource into an answer when a summary is what was asked for — and
consider `saveFile()` instead, which turns the result into a file the user can
open.

## Cleaning up

```
browser_tasks {action: "finish", task: "orders"}
```

Once, after verification, or when abandoning a failed task. It closes the pages
the task opened and leaves any tab you were given with `claimTab` alone. Pass
`keep: true` only when the pages are something for the user to look at.
