# Repository changes

This application feature turns an eligible, completed repository analysis into one durable, review-only change request. It has no Azure DevOps, Git, HTTP, filesystem, or model-SDK dependency.

The feature schedules idempotently from `analysis.completed.v1`, asks an outer planning/authoring adapter for a bounded replacement-file draft, and asks an outer repository provider adapter to create a **draft** pull request. It never runs a target repository's tests or completes a pull request. All external input is validated by the owning adapter before reaching these ports.
