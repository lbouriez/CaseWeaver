# Azure DevOps Repositories connector

This is the Azure DevOps-specific outer adapter for CaseWeaver's automated draft-pull-request feature. It receives server-resolved HTTPS repository configuration and a write-capable credential only at its boundary, creates a bounded text-file commit on a `caseweaver/analysis/*` branch, then creates a draft pull request. It does not complete pull requests, alter branch policies, or run repository tests.
