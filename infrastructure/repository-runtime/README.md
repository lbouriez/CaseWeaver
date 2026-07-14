# Repository runtime infrastructure

**PBI:** 010

`AttestedRepositoryRuntime` composes injected checkout and sandbox implementations.
It permits the checkout secret reference only at the broker boundary, validates the
administrator-selected pinned tree and evidence, and provides the agent only an explicit
read-only tool gateway. Sandboxes must attest network, credential, filesystem, tool, and
quota isolation; timeout/cancellation terminates and cleans up the session.

Agent prompting and model calls remain in provider/application layers.
