import { createContext, type ReactNode, useContext } from "react";

import type { CaseWeaverApiClient } from "./api-client.js";

const ApiClientContext = createContext<CaseWeaverApiClient | undefined>(
  undefined,
);

export function ApiClientProvider({
  client,
  children,
}: {
  readonly client: CaseWeaverApiClient;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ApiClientContext.Provider value={client}>
      {children}
    </ApiClientContext.Provider>
  );
}

export function useApiClient(): CaseWeaverApiClient {
  const client = useContext(ApiClientContext);
  if (client === undefined) {
    throw new Error("The CaseWeaver API client is not available.");
  }
  return client;
}
