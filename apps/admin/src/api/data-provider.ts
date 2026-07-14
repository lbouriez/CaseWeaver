import type {
  DataProvider,
  GetListParams,
  GetManyParams,
  GetManyReferenceParams,
  GetOneParams,
  QueryFunctionContext,
} from "react-admin";

import { type CaseWeaverApiClient, PublicApiError } from "./api-client.js";
import {
  type AdminListItem,
  type AdminResourceName,
  resourceNames,
} from "./contracts.js";

function toResourceName(resource: string): AdminResourceName {
  const match = resourceNames.find((candidate) => candidate === resource);
  if (match === undefined) {
    throw new PublicApiError(
      "unavailable",
      "resource.unsupported",
      "This console route is not backed by an approved administration resource.",
    );
  }
  return match;
}

function toFilter(
  filter: unknown,
): Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(filter)) return {};
  return Object.fromEntries(
    Object.entries(filter).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listData(items: readonly AdminListItem[]) {
  return items.map((item) => ({ ...item }));
}

function mutationUnavailable<RecordType>(): Promise<RecordType> {
  return Promise.reject(
    new PublicApiError(
      "unavailable",
      "resource.immutable",
      "This resource is read-only in the operator console. Use its explicit workflow.",
    ),
  );
}

export function createDataProvider(client: CaseWeaverApiClient): DataProvider {
  const cursors = new Map<string, string>();

  const cursorKey = (
    resource: AdminResourceName,
    perPage: number,
    page: number,
    sort: string | undefined,
    direction: "ASC" | "DESC" | undefined,
    filter: Readonly<Record<string, string | number | boolean>>,
  ) =>
    JSON.stringify({
      direction,
      filter: Object.entries(filter).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      page,
      perPage,
      resource,
      sort,
    });

  const provider = {
    async getList(
      resource: string,
      params: GetListParams & QueryFunctionContext,
    ) {
      const resolvedResource = toResourceName(resource);
      const perPage = params.pagination?.perPage ?? 25;
      const page = params.pagination?.page ?? 1;
      const filter = toFilter(params.filter);
      const after =
        page === 1
          ? undefined
          : cursors.get(
              cursorKey(
                resolvedResource,
                perPage,
                page - 1,
                params.sort?.field,
                params.sort?.order,
                filter,
              ),
            );
      if (page > 1 && after === undefined) {
        throw new PublicApiError(
          "invalid",
          "pagination.cursorUnavailable",
          "Return to the first page before requesting a later cursor page.",
        );
      }
      const result = await client.list(
        resolvedResource,
        {
          limit: perPage,
          after,
          sort: params.sort?.field,
          direction: params.sort?.order,
          filter,
        },
        { signal: params.signal },
      );
      if (result.page.endCursor !== undefined) {
        cursors.set(
          cursorKey(
            resolvedResource,
            perPage,
            page,
            params.sort?.field,
            params.sort?.order,
            filter,
          ),
          result.page.endCursor,
        );
      }
      return {
        data: listData(result.items),
        pageInfo: { hasNextPage: result.page.hasNextPage },
      };
    },
    async getOne(
      resource: string,
      params: GetOneParams & QueryFunctionContext,
    ) {
      const detail = await client.get(
        toResourceName(resource),
        String(params.id),
        params.signal,
      );
      return { data: detail };
    },
    async getMany(
      resource: string,
      params: GetManyParams & QueryFunctionContext,
    ) {
      const target = toResourceName(resource);
      const records = await Promise.all(
        params.ids.map((id) => client.get(target, String(id), params.signal)),
      );
      return { data: records };
    },
    async getManyReference(
      resource: string,
      params: GetManyReferenceParams & QueryFunctionContext,
    ) {
      const result = await client.list(
        toResourceName(resource),
        {
          limit: params.pagination.perPage,
          sort: params.sort.field,
          direction: params.sort.order,
          filter: {
            ...toFilter(params.filter),
            [params.target]: String(params.id),
          },
        },
        { signal: params.signal },
      );
      return {
        data: listData(result.items),
        pageInfo: { hasNextPage: result.page.hasNextPage },
      };
    },
    create() {
      return mutationUnavailable();
    },
    update() {
      return mutationUnavailable();
    },
    updateMany() {
      return mutationUnavailable();
    },
    delete() {
      return mutationUnavailable();
    },
    deleteMany() {
      return mutationUnavailable();
    },
  };
  // React-Admin declares arbitrary caller-selected record generics. This adapter only
  // registers the validated CaseWeaver record shape and rejects every other resource.
  return provider as DataProvider;
}
