# Attachment processing runtime

**PBI:** 008

Disposable isolated execution for archive, image, and structured-text processors.
Enforces path/symlink confinement, network and credential isolation, workspace-scoped
input/output, CPU, memory, file-count, expansion, output, and time limits.

Processor selection and derivative policy remain in `packages/attachments`.

## Production processor boundary

`UnixSocketAttachmentExecutor` is the privileged worker-side implementation of
`IsolatedAttachmentExecutor`. It streams one bounded opaque object-store input into a
fresh UUID directory beneath a deployment-owned jobs root, then sends a single
line-delimited UTF-8 JSON request over a local Unix domain socket. The request contains
only the job UUID, `text` or `zip` processor choice, and validated numeric quotas. It
never contains a path, blob handle, workspace identity, content, secret, or error text.

`UnixSocketAttachmentProcessorService` is the networkless, credential-free sidecar
half. It accepts that fixed protocol only, derives fixed `input.bin` and `output.txt`
paths below the canonical jobs root, rejects symlinks and non-regular files, and applies
the text/ZIP limits before returning only `{ kind, jobId, outputByteLength }` or a safe
failure code. ZIP input is central-directory validated before bounded stored/deflated
entry extraction; unsafe paths, symlinks, devices, encryption, ZIP extensions, deep or
over-limit archives fail closed. The worker independently verifies canonical UTF-8
output before committing it to the supplied opaque output handle.

The process boundary has no Docker socket, shell execution, TCP listener, arbitrary
mount request, environment forwarding, or credentials. Deployment composition must use
a private shared volume for the jobs root, a Unix socket visible only to the worker and
processor, matching unprivileged filesystem identity, and container-level CPU, memory,
process, filesystem, and network restrictions. Requests can only lower the configured
hard ceilings. Cancellation sends a path-free cancel message and both sides remove only
their generated UUID job directory.

The processor service leaves a successful job directory long enough for the worker to
verify and persist `output.txt`; the worker is the sole owner of final successful-job
cleanup. Failed/cancelled service jobs are removed by the service immediately.

`VerifiedAttachmentDerivativeEvidenceReader` is the server-private PBI-008
adapter for frozen analysis evidence. It resolves one workspace-scoped derivative
association, opens only its opaque storage handle, and independently verifies the
stored canonical UTF-8 byte length and SHA-256 before returning text. It has no URL,
download, or arbitrary object-read surface.
