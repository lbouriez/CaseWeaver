# Scheduling

**PBIs:** 004, 012

Vendor-neutral schedule models and due-time evaluation for knowledge synchronization,
case polling, periodic full rescans, timezone handling, jitter, overlap, and deterministic
command keys.

No timers, database calls, connector calls, or job execution; apps provide those ports.

`KnowledgeScheduler` only finds due schedules, obtains a fencing lease, derives a
deterministic occurrence key, and asks its store to atomically persist an occurrence,
durable command handoff, and next-run state. It has no connector or AI dependency.
