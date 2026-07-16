# Attachment processing runtime

**PBI:** 008

Disposable isolated execution for archive, image, and structured-text processors.
Enforces path/symlink confinement, network and credential isolation, workspace-scoped
input/output, CPU, memory, file-count, expansion, output, and time limits.

Processor selection and derivative policy remain in `packages/attachments`.

`VerifiedAttachmentDerivativeEvidenceReader` is the server-private PBI-008
adapter for frozen analysis evidence. It resolves one workspace-scoped derivative
association, opens only its opaque storage handle, and independently verifies the
stored canonical UTF-8 byte length and SHA-256 before returning text. It has no URL,
download, or arbitrary object-read surface.
