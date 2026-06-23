# TODOS

## Managed-session engine

### Double-recycle pool growth on wedged worker
**Priority:** P2
**What:** `probeHealth` (15s) and the dead-man timer (120s) can both call
`onTimeout` for the same `reqId` (`session/manager.js:290` and `:264`). Both pass the
`!p.settled` guard before the async `runFallbackRaw` await, so two fallbacks spawn and
`recycle(w)` runs twice on a stale `w` — the worker pool grows by 1 per wedged event.
**Why:** Unbounded worker growth under repeated wedged-dialog scenarios.
**Fix:** Add a re-entry guard at the top of `onTimeout` (e.g. a `recycling` flag or
check `w.state === UNHEALTHY`) before recycle.
**Source:** pre-landing review, 2026-06-23.

### stop() abandons in-flight pending promises
**Priority:** P2
**What:** `stop()` (`session/manager.js:117`) clears timers and `workers` but never
rejects entries in `this.pending` / clears `this.queues`. Callers awaiting `submit()`
have their promise abandoned.
**Why:** Harmless at daemon shutdown (process exits) but leaks promises; wrong if `stop()`
is ever called mid-process.
**Fix:** Iterate `pending`, `p.reject(new Error('SessionManager stopped'))` each unsettled
entry, then `pending.clear()` + `queues.clear()`.
**Source:** pre-landing review, 2026-06-23.

### worker-server cannot reconnect after daemon restart
**Priority:** P2
**What:** `worker-server.js:34` caches `clientPromise`; it only resets to null on initial
connect failure. If the daemon restarts mid-worker-life, the cached client is `ECLOSED`
and every `rpc()` fails until the worker is recycled (up to 120s).
**Fix:** In `rpc()`, catch `ECLOSED`, reset `clientPromise = null`, retry once.
**Source:** pre-landing review, 2026-06-23.

### Double fallback spawn on nudge-failure race (P3)
**Priority:** P3
**What:** `manager.js:251` — if `nudge()` rejects and the dead-man timer fires in the
async gap, both call `runFallbackRaw` (second `settle` is a no-op but a `claude -p` token
is wasted). Fix: cancel `p.timer` at the top of `onTimeout`, not only in `settle()`.

### Clear queues on stop() (P3)
**Priority:** P3
**What:** `this.queues` is never cleared in `stop()`; folds into the stop() P2 fix above.

## Memory / session-start

### Reprocess session transcripts → facts
**Priority:** P3 (deferred — depends on the SessionStart pivot landing)
**What:** Parse `~/.sigil/sessions/<id>/` session caches and the
`claude_session.transcript_path` per session, extract durable facts, ingest with AUDM dedup.
**Why:** Closes "track all chats and sessions to store knowledge" — turns passive session
history into recalled memory; attacks the empty-store problem.
**Cons:** New ingestion subsystem (parse/extract/dedup/retention + LLM cost per session).
**Context:** Substrate exists after the SessionStart work lands (per-session folders +
`claude_session.transcript_path`). Reuse `src/ingestion/pipeline.js` + AUDM.
**Depends on:** SessionStart cache design tasks. Run async (SessionEnd/background), never in
the session-start hook budget.
**Start at:** `src/memory/pods/kinds/claude_session.js`, `src/ingestion/pipeline.js`.

## Completed

_(none yet)_
