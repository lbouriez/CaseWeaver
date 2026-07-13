import { ConnectorCancelledError, ConnectorProtocolError } from "./errors.js";
import type {
  ConnectorCursor,
  CursorPage,
  CursorPageRequest,
} from "./primitives.js";

export type FetchCursorPage<TItem> = (
  request: CursorPageRequest,
) => Promise<CursorPage<TItem>>;

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ConnectorCancelledError();
  }
}

function cursorIdentity(cursor: ConnectorCursor): string {
  return `${cursor.version}\u0000${cursor.value}`;
}

/**
 * Iterates opaque cursors without interpreting them. It detects a cursor cycle so a
 * connector cannot spin forever after a malformed remote pagination response.
 */
export async function* paginate<TItem>(
  request: CursorPageRequest,
  fetchPage: FetchCursorPage<TItem>,
): AsyncIterable<CursorPage<TItem>> {
  let cursor = request.cursor;
  const seenCursors = new Set<string>();

  if (cursor !== undefined) {
    seenCursors.add(cursorIdentity(cursor));
  }

  while (true) {
    throwIfAborted(request.signal);
    const page = await fetchPage({ ...request, cursor });
    throwIfAborted(request.signal);

    yield page;

    if (page.nextCursor === undefined) {
      return;
    }

    const nextCursorIdentity = cursorIdentity(page.nextCursor);
    if (seenCursors.has(nextCursorIdentity)) {
      throw new ConnectorProtocolError(
        "Connector pagination returned a cursor that was already seen.",
      );
    }

    seenCursors.add(nextCursorIdentity);
    cursor = page.nextCursor;
  }
}
