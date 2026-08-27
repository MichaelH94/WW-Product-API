export const ADMIN_API_VERSION = "2026-07";
export const ADMIN_GRAPHQL_ENDPOINT =
  `shopify:admin/api/${ADMIN_API_VERSION}/graphql.json`;

export type GraphqlVariables = Record<string, unknown>;

export type AdminGraphqlExecutor = <T>(
  query: string,
  variables?: GraphqlVariables,
) => Promise<T>;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface GraphqlErrorDetail {
  message: string;
  path?: ReadonlyArray<string | number>;
  extensions?: Record<string, unknown>;
}

export class ShopifyAdminApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShopifyAdminApiError";
  }
}

export class ShopifyAdminHttpError extends ShopifyAdminApiError {
  readonly status: number;
  readonly statusText: string;
  readonly retryAfter: string | null;

  constructor(status: number, statusText: string, retryAfter: string | null = null) {
    super(`Shopify Admin API request failed with HTTP ${status} ${statusText}`.trim());
    this.name = "ShopifyAdminHttpError";
    this.status = status;
    this.statusText = statusText;
    this.retryAfter = retryAfter;
  }
}

export class ShopifyAdminTimeoutError extends ShopifyAdminApiError {
  constructor(options?: ErrorOptions) {
    super("Shopify Admin API request timed out", options);
    this.name = "ShopifyAdminTimeoutError";
  }
}

export class ShopifyAdminGraphqlError extends ShopifyAdminApiError {
  readonly errors: ReadonlyArray<GraphqlErrorDetail>;

  constructor(errors: ReadonlyArray<GraphqlErrorDetail>) {
    super(`Shopify Admin GraphQL error: ${errors.map(({ message }) => message).join("; ")}`);
    this.name = "ShopifyAdminGraphqlError";
    this.errors = errors;
  }
}

export class ShopifyAdminResponseError extends ShopifyAdminApiError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShopifyAdminResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGraphqlErrors(value: unknown): GraphqlErrorDetail[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.message !== "string") return [];

    return [{
      message: item.message,
      path: Array.isArray(item.path)
        ? item.path.filter((part): part is string | number =>
            typeof part === "string" || typeof part === "number")
        : undefined,
      extensions: isRecord(item.extensions) ? item.extensions : undefined,
    }];
  });
}

function isTimeoutError(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    "name" in value && value.name === "TimeoutError";
}

export function createAdminGraphqlExecutor(
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): AdminGraphqlExecutor {
  return async function executeAdminGraphql<T>(
    query: string,
    variables: GraphqlVariables = {},
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetcher(ADMIN_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      if (isTimeoutError(cause)) {
        throw new ShopifyAdminTimeoutError({cause});
      }
      throw new ShopifyAdminApiError(
        "Unable to reach the Shopify Admin API",
        { cause },
      );
    }

    if (!response.ok) {
      throw new ShopifyAdminHttpError(
        response.status,
        response.statusText,
        response.headers.get("retry-after"),
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch (cause) {
      throw new ShopifyAdminResponseError(
        "Shopify Admin API returned invalid JSON",
        { cause },
      );
    }

    if (!isRecord(payload)) {
      throw new ShopifyAdminResponseError(
        "Shopify Admin API returned an invalid response envelope",
      );
    }

    const errors = parseGraphqlErrors(payload.errors);
    if (errors.length > 0) {
      throw new ShopifyAdminGraphqlError(errors);
    }

    if (!("data" in payload) || !isRecord(payload.data)) {
      throw new ShopifyAdminResponseError(
        "Shopify Admin API response did not contain data",
      );
    }

    return payload.data as T;
  };
}

export const executeAdminGraphql = createAdminGraphqlExecutor();
