# Contract tests

**PBIs:** 003, 006

Reusable connector and AI-provider conformance suites. Every new adapter must pass the
relevant suite without modifying expectations to fit the vendor.

Use separate `ai` and `connectors` subdirectories so PBIs 003 and 006 can work without
sharing files.
