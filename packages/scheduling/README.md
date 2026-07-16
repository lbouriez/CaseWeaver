# Scheduling

**PBIs:** 004, 012

Vendor-neutral schedule models and due-time evaluation for knowledge synchronization,
case polling, periodic full rescans, timezone handling, jitter, overlap, and deterministic
command keys.

No timers, database calls, connector calls, or job execution; apps provide those ports.

`KnowledgeScheduler` only finds due schedules, obtains a fencing lease, derives a
deterministic occurrence key, and asks its store to atomically persist an occurrence,
durable command handoff, and next-run state. It has no connector or AI dependency.

Knowledge commands carry the schedule-selected immutable source configuration version,
the paired immutable connector configuration version, and a `schedule` trigger marker.
Workers must verify both pins before connector I/O; manual requests use the same v2
domain envelope with a `manual` trigger. Legacy v1 commands are not scheduled and must
be classified unavailable rather than resolving mutable runtime configuration.

`CaseAnalysisScheduler` emits only `analysis.trigger.v2` through a durable store that
discovers an exact active trigger revision, retained connector configuration, case target,
and automated actor. Its occurrence handoff must atomically retain the immutable trigger
request, idempotency record, audit event, v2 outbox envelope, and next-run state. Legacy
case-analysis rows lack that proof and fail closed before lease or command emission;
they must never be rebound to a current configuration or produce `analysis.trigger.v1`.
