export const ADMIN_API_VERSION = "2026-07";

export type GraphqlVariables = Record<string, unknown>;

export interface ShopifyRequestContext {
  requestId: string;
  route: string;
  operation?: string;
  attempt?: number;
}

export type AdminGraphqlExecutor = <T>(
  query: string,
  variables?: GraphqlVariables,
  context?: ShopifyRequestContext,
) => Promise<T>;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ShopifyGraphqlCostMetadata {
  requestedQueryCost: number | null;
  actualQueryCost: number | null;
  currentlyAvailable: number | null;
  restoreRate: number | null;
}

export type ShopifyGraphqlCostDebug = Record<string, unknown>;

export interface AdminGraphqlExecutorOptions {
  onCostDebug?: (
    cost: ShopifyGraphqlCostDebug,
    context?: ShopifyRequestContext,
  ) => void;
}

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
  readonly requestId: string | null;

  constructor(
    status: number,
    statusText: string,
    retryAfter: string | null = null,
    requestId: string | null = null,
  ) {
    super(`Shopify Admin API request failed with HTTP ${status} ${statusText}`.trim());
    this.name = "ShopifyAdminHttpError";
    this.status = status;
    this.statusText = statusText;
    this.retryAfter = retryAfter;
    this.requestId = requestId;
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

export class ShopifyAdminRetryExhaustedError extends ShopifyAdminApiError {
  readonly category: string;
  readonly attempts: number;
  readonly lastError: ShopifyAdminApiError;
  readonly shopifyRequestIds: readonly string[];

  constructor(options: {
    category: string;
    attempts: number;
    lastError: ShopifyAdminApiError;
    shopifyRequestIds?: readonly string[];
  }) {
    super("Shopify read request failed after bounded retries", {
      cause: options.lastError,
    });
    this.name = "ShopifyAdminRetryExhaustedError";
    this.category = options.category;
    this.attempts = options.attempts;
    this.lastError = options.lastError;
    this.shopifyRequestIds = options.shopifyRequestIds ?? [];
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
  fetcher: FetchLike,
  endpoint = "",
  options: AdminGraphqlExecutorOptions = {},
): AdminGraphqlExecutor {
  return async function executeAdminGraphql<T>(
    query: string,
    variables: GraphqlVariables = {},
    context?: ShopifyRequestContext,
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      if (cause instanceof ShopifyAdminApiError) throw cause;
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
        response.headers.get("x-request-id") ??
          response.headers.get("x-shopify-request-id"),
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

    const extensions = isRecord(payload.extensions) ? payload.extensions : null;
    if (options.onCostDebug && extensions && isRecord(extensions.cost)) {
      options.onCostDebug(extensions.cost, context);
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
