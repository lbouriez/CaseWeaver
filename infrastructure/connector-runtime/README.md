# Connector runtime composition

**PBIs:** 005, 007, 013

Trusted server-side composition for connector capabilities selected by an exact
immutable descriptor-backed configuration version. It depends inward on the
administration private configuration contract and connector SDK only.

This package never exposes settings, secret locators, resolved secrets, or
connector clients through an HTTP DTO, audit, log, trace, or diagnostic. A
worker resolves an exact durable connector configuration pin and selects a
contribution using its `kind`, `type`, and `version`; it never follows a
connector aggregate's mutable current configuration.

`EnvironmentConnectorSecretResolver` is the deliberately narrow open-source
default: only `env:UPPERCASE_NAME` locators are accepted. Deployments may
inject a Vault/KMS resolver through the same SDK port. Missing, unsupported,
or cancelled resolution fails closed.

Adapter contributions belong to the connector packages. This package owns only
the provider-neutral registry and resolution boundary; it contains no vendor
conditionals or feature business policy.

`resolveAttachmentSource` selects a declared `AttachmentSource` only through the same
exact immutable connector configuration pin as knowledge, case, and destination
capabilities. It returns a server-side stream capability only; attachment references
and opaque reopen identities remain within trusted worker composition.
