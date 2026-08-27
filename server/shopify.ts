import {
  ADMIN_API_VERSION,
  createAdminGraphqlExecutor,
  ShopifyAdminApiError,
  ShopifyAdminGraphqlError,
  ShopifyAdminHttpError,
  ShopifyAdminResponseError,
  ShopifyAdminRetryExhaustedError,
  ShopifyAdminTimeoutError,
  type AdminGraphqlExecutor,
  type FetchLike,
  type GraphqlVariables,
  type ShopifyGraphqlCostMetadata,
  type ShopifyRequestContext,
} from "../shared/shopify/admin.ts";

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export interface ShopifyAccessTokenProvider {
  (): Promise<string>;
  invalidate(token?: string): void;
}

export function createClientCredentialsTokenProvider(options: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  fetcher?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): ShopifyAccessTokenProvider {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let token: string | null = null;
  let expiresAt = 0;
  let pending: Promise<string> | null = null;

  const getAccessToken = async () => {
    if (token && now() < expiresAt - 60_000) return token;
    if (pending) return pending;

    pending = (async () => {
      const response = await fetcher(
        `https://${options.shopDomain}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          signal: AbortSignal.timeout(timeoutMs),
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: options.clientId,
            client_secret: options.clientSecret,
          }),
        },
      );
      if (!response.ok) {
        throw new ShopifyAdminApiError(
          `Shopify client-credentials request failed with HTTP ${response.status}`,
        );
      }

      const payload = await response.json() as Partial<TokenResponse>;
      if (
        typeof payload.access_token !== "string" ||
        !payload.access_token ||
        typeof payload.expires_in !== "number" ||
        payload.expires_in <= 0
      ) {
        throw new ShopifyAdminApiError(
          "Shopify client-credentials response was invalid",
        );
      }

      token = payload.access_token;
      expiresAt = now() + payload.expires_in * 1000;
      return token;
    })().finally(() => {
      pending = null;
    });

    return pending;
  };

  getAccessToken.invalidate = (invalidToken?: string) => {
    if (invalidToken === undefined || token === invalidToken) {
      token = null;
      expiresAt = 0;
    }
  };

  return getAccessToken;
}

export function createShopifyAdminGraphqlExecutor(options: {
  shopDomain: string;
  getAccessToken: (() => Promise<string>) & {
    invalidate?: (token?: string) => void;
  };
  fetcher?: FetchLike;
  timeoutMs?: number;
  costDebug?: boolean;
  onCostDebug?: (cost: Record<string, unknown>) => void;
} & ShopifyReadRetryOptions): AdminGraphqlExecutor {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const endpoint = `https://${options.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maximumAttempts = options.maximumAttempts ?? 3;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) {
    throw new RangeError("maximumAttempts must be an integer between 1 and 3");
  }
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const requestedCostByOperation = new Map<string, number>();
  let capacity: {
    currentlyAvailable: number;
    restoreRate: number;
    observedAt: number;
  } | null = null;

  const baseExecutor = createAdminGraphqlExecutor(async (_input, init) => {
    const send = async (accessToken: string) => fetcher(endpoint, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        "X-Shopify-Access-Token": accessToken,
        ...(options.costDebug
          ? {"Shopify-GraphQL-Cost-Debug": "1"}
          : {}),
      },
    });

    let accessToken = await options.getAccessToken();
    let response = await send(accessToken);

    if (response.status === 401 && options.getAccessToken.invalidate) {
      options.getAccessToken.invalidate(accessToken);
      accessToken = await options.getAccessToken();
      response = await send(accessToken);
    }

    return response;
  }, endpoint, {
    onCostDebug: (cost, context) => {
      const metadata = costMetadata(cost);
      if (context?.operation && metadata.requestedQueryCost !== null) {
        requestedCostByOperation.set(context.operation, metadata.requestedQueryCost);
      }
      if (
        metadata.currentlyAvailable !== null &&
        metadata.restoreRate !== null &&
        metadata.restoreRate > 0
      ) {
        capacity = {
          currentlyAvailable: metadata.currentlyAvailable,
          restoreRate: metadata.restoreRate,
          observedAt: now(),
        };
      }
      safeLog(options.logger, {
        event: "shopify_query_cost",
        requestId: context?.requestId ?? "unscoped",
        route: context?.route ?? "unknown",
        operation: context?.operation ?? "unknown",
        attempt: context?.attempt ?? 1,
        queryCost: metadata,
      });
      options.onCostDebug?.(cost);
    },
  });

  async function waitForCapacity(
    operation: string,
    context: ShopifyRequestContext | undefined,
    attempt: number,
  ): Promise<void> {
    const requestedCost = requestedCostByOperation.get(operation);
    if (!capacity || requestedCost === undefined) return;
    const elapsedSeconds = Math.max(0, now() - capacity.observedAt) / 1000;
    const estimatedAvailable = capacity.currentlyAvailable +
      elapsedSeconds * capacity.restoreRate;
    if (estimatedAvailable >= requestedCost) return;
    const waitMs = Math.min(
      5_000,
      Math.ceil((requestedCost - estimatedAvailable) / capacity.restoreRate * 1000),
    );
    if (waitMs <= 0) return;
    safeLog(options.logger, {
      event: "shopify_capacity_wait",
      requestId: context?.requestId ?? "unscoped",
      route: context?.route ?? "unknown",
      operation,
      attempt,
      waitMs,
      queryCost: {
        requestedQueryCost: requestedCost,
        currentlyAvailable: Math.max(0, estimatedAvailable),
        restoreRate: capacity.restoreRate,
      },
    });
    await sleep(waitMs);
  }

  return async function executeShopifyRead<T>(
    query: string,
    variables: GraphqlVariables = {},
    context?: ShopifyRequestContext,
  ): Promise<T> {
    const operation = operationName(query);
    const isSafeRead = /^\s*query\b/.test(query);
    const collectedRequestIds = new Set<string>();

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      await waitForCapacity(operation, context, attempt);
      const attemptContext: ShopifyRequestContext = {
        requestId: context?.requestId ?? "unscoped",
        route: context?.route ?? "unknown",
        operation,
        attempt,
      };
      try {
        const result = await baseExecutor<T>(query, variables, attemptContext);
        safeLog(options.logger, {
          event: "shopify_upstream_success",
          requestId: attemptContext.requestId,
          route: attemptContext.route,
          operation,
          attempt,
          final: true,
        });
        return result;
      } catch (error) {
        const classification = classifyRetry(error);
        const retryable = isSafeRead && classification.retryable;
        for (const requestId of classification.shopifyRequestIds) {
          collectedRequestIds.add(requestId);
        }
        const final = !retryable || attempt === maximumAttempts;
        safeLog(options.logger, {
          event: "shopify_upstream_failure",
          requestId: attemptContext.requestId,
          route: attemptContext.route,
          operation,
          attempt,
          category: classification.category,
          ...(classification.upstreamStatus === undefined
            ? {}
            : {upstreamStatus: classification.upstreamStatus}),
          ...(classification.shopifyRequestIds.length
            ? {shopifyRequestIds: classification.shopifyRequestIds}
            : {}),
          retryable,
          final,
        });

        if (!retryable) throw error;
        if (attempt === maximumAttempts) {
          const lastError = error instanceof ShopifyAdminApiError
            ? error
            : new ShopifyAdminApiError("Unable to reach the Shopify Admin API");
          throw new ShopifyAdminRetryExhaustedError({
            category: classification.category,
            attempts: attempt,
            lastError,
            shopifyRequestIds: [...collectedRequestIds],
          });
        }

        const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 101);
        const delayMs = Math.max(
          RETRY_DELAYS_MS[attempt - 1] + jitter,
          retryAfterMilliseconds(classification.retryAfter, now()),
        );
        safeLog(options.logger, {
          event: "shopify_retry_scheduled",
          requestId: attemptContext.requestId,
          route: attemptContext.route,
          operation,
          attempt,
          category: classification.category,
          delayMs,
        });
        await sleep(delayMs);
      }
    }

    throw new ShopifyAdminApiError("Shopify read request did not complete");
  };
}

export type ShopifySafeLogger = (event: Record<string, unknown>) => void;

export interface ShopifyReadRetryOptions {
  maximumAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logger?: ShopifySafeLogger;
}

interface RetryClassification {
  retryable: boolean;
  category: string;
  upstreamStatus?: number;
  retryAfter?: string | null;
  shopifyRequestIds: string[];
}

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_GRAPHQL_CODES = new Set([
  "THROTTLED",
  "INTERNAL_SERVER_ERROR",
]);
const RETRY_DELAYS_MS = [200, 500];

function safeLog(logger: ShopifySafeLogger | undefined, event: Record<string, unknown>): void {
  if (!logger) return;
  try {
    logger(event);
  } catch {
    // Diagnostics must never affect request behavior.
  }
}

function operationName(query: string): string {
  return /\bquery\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(query)?.[1] ??
    "AnonymousQuery";
}

function graphqlRequestIds(error: ShopifyAdminGraphqlError): string[] {
  return [...new Set(error.errors.flatMap(({extensions}) => {
    const requestId = extensions?.requestId;
    return typeof requestId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(requestId)
      ? [requestId]
      : [];
  }))];
}

function classifyRetry(error: unknown): RetryClassification {
  if (error instanceof ShopifyAdminTimeoutError) {
    return {retryable: true, category: "network_timeout", shopifyRequestIds: []};
  }
  if (error instanceof ShopifyAdminHttpError) {
    return {
      retryable: RETRYABLE_HTTP_STATUSES.has(error.status),
      category: `http_${error.status}`,
      upstreamStatus: error.status,
      retryAfter: error.retryAfter,
      shopifyRequestIds: error.requestId ? [error.requestId] : [],
    };
  }
  if (error instanceof ShopifyAdminGraphqlError) {
    const codes = error.errors.flatMap(({extensions}) =>
      typeof extensions?.code === "string" ? [extensions.code] : []);
    return {
      retryable: codes.length > 0 &&
        codes.every((code) => RETRYABLE_GRAPHQL_CODES.has(code)),
      category: codes.length === 1
        ? `graphql_${codes[0].toLowerCase()}`
        : "graphql_error",
      shopifyRequestIds: graphqlRequestIds(error),
    };
  }
  if (
    error instanceof ShopifyAdminApiError &&
    !(error instanceof ShopifyAdminResponseError) &&
    error.message === "Unable to reach the Shopify Admin API"
  ) {
    return {retryable: true, category: "network_failure", shopifyRequestIds: []};
  }
  return {retryable: false, category: "non_retryable", shopifyRequestIds: []};
}

function retryAfterMilliseconds(value: string | null | undefined, now: number): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function costMetadata(value: Record<string, unknown>): ShopifyGraphqlCostMetadata {
  const throttleStatus = typeof value.throttleStatus === "object" &&
      value.throttleStatus !== null && !Array.isArray(value.throttleStatus)
    ? value.throttleStatus as Record<string, unknown>
    : {};
  const finite = (candidate: unknown): number | null =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  return {
    requestedQueryCost: finite(value.requestedQueryCost),
    actualQueryCost: finite(value.actualQueryCost),
    currentlyAvailable: finite(throttleStatus.currentlyAvailable),
    restoreRate: finite(throttleStatus.restoreRate),
  };
}

// Retain the Node entry point's existing import while the shared transport is
// also used by Cloudflare Workers.
export const createServerAdminGraphqlExecutor = createShopifyAdminGraphqlExecutor;
