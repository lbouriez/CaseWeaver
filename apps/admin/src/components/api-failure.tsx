import { Alert, AlertTitle, Button, Stack, Typography } from "@mui/material";

import { PublicApiError } from "../api/api-client.js";

export function ApiFailure({
  error,
  retry,
}: {
  readonly error: unknown;
  readonly retry?: () => void;
}) {
  const failure =
    error instanceof PublicApiError
      ? error
      : new PublicApiError(
          "failed",
          "client.failure",
          "The operator console could not complete this request.",
        );
  const title = {
    unauthenticated: "Session required",
    denied: "Access denied",
    invalid: "Validation failed",
    conflict: "Configuration conflict",
    unavailable: "Control-plane unavailable",
    cancelled: "Request cancelled",
    failed: "Request failed",
  }[failure.kind];

  return (
    <Alert
      aria-live="assertive"
      role="alert"
      severity={
        failure.kind === "denied" || failure.kind === "unavailable"
          ? "warning"
          : "error"
      }
      sx={{ borderRadius: 0 }}
    >
      <AlertTitle>{title}</AlertTitle>
      <Stack spacing={1}>
        <Typography variant="body2">{failure.message}</Typography>
        {failure.kind === "conflict" ? (
          <Typography variant="body2">
            Refresh the resource and compare the current immutable version
            before retrying.
          </Typography>
        ) : null}
        {failure.requestId === undefined ? null : (
          <Typography sx={{ fontFamily: "monospace" }} variant="caption">
            Request {failure.requestId}
          </Typography>
        )}
        {retry === undefined || !failure.retryable ? null : (
          <BoxedRetry onClick={retry} />
        )}
      </Stack>
    </Alert>
  );
}

function BoxedRetry({ onClick }: { readonly onClick: () => void }) {
  return (
    <span>
      <Button color="inherit" onClick={onClick} size="small" variant="outlined">
        Retry request
      </Button>
    </span>
  );
}
