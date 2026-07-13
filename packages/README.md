# Vendor-neutral packages

Reusable TypeScript modules containing domain, ports, policies, and application logic.
Packages may not depend on `apps`, `connectors`, `providers`, or `infrastructure`.

Avoid generic shared packages. New packages need a cohesive capability, clear public
API, and an inward dependency direction.
