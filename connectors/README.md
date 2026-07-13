# Connectors

Adapters for external knowledge sources, case systems, attachments, destinations, and
webhooks. A connector may implement several capabilities while sharing one authenticated
client.

Connectors depend on `connector-sdk` and inward contracts, never on apps or concrete
persistence.
