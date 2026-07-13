# Security

**PBIs:** 002, 008, 010, 012, 013

Code-owned workspace roles (`administrator`, `operator`, `analyst`, and `viewer`),
permission policy, secret-reference audit contracts, and immutable audit record
contracts. Decisions always require matching workspace and principal IDs.

Authentication transports and secret stores are outer adapters. This package depends
only on `@caseweaver/domain`.
