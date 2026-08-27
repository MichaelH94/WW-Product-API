import {handleApiRequest} from "../server/api.ts";
import {
  createClientCredentialsTokenProvider,
  createShopifyAdminGraphqlExecutor,
  type ShopifySafeLogger,
} from "../server/shopify.ts";
import type {FetchLike} from "../shared/shopify/admin.ts";
import {createProductDataAccess} from "../shared/shopify/products.ts";
import {loadWorkerConfig, type WorkerEnvironment} from "./config.ts";

interface WorkerRuntime {
  dataAccess: ReturnType<typeof createProductDataAccess>;
  internalApiKey: string;
}

export interface WorkerHandlerOptions {
  fetcher?: FetchLike;
  now?: () => number;
  tokenTimeoutMs?: number;
  adminTimeoutMs?: number;
  onCostDebug?: (cost: Record<string, unknown>) => void;
  retrySleep?: (milliseconds: number) => Promise<void>;
  retryRandom?: () => number;
  logger?: ShopifySafeLogger;
}

function productionLogger(event: Record<string, unknown>): void {
  console.info(JSON.stringify(event));
}

function safeLog(logger: ShopifySafeLogger, event: Record<string, unknown>): void {
  try {
    logger(event);
  } catch {
    // Logging must never affect API behavior.
  }
}

function internalConfigurationError(): Response {
  const requestId = crypto.randomUUID();
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The API is not configured correctly",
      },
      meta: {requestId},
    },
    {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    },
  );
}

export function createWorkerHandler(options: WorkerHandlerOptions = {}) {
  let runtime: WorkerRuntime | null = null;
  const logger = options.logger ?? productionLogger;

  return async function fetchWorker(
    request: Request,
    environment: WorkerEnvironment,
  ): Promise<Response> {
    try {
      if (runtime === null) {
        const config = loadWorkerConfig(environment);
        const getAccessToken = createClientCredentialsTokenProvider({
          shopDomain: config.shopDomain,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          ...(options.fetcher ? {fetcher: options.fetcher} : {}),
          ...(options.now ? {now: options.now} : {}),
          ...(options.tokenTimeoutMs
            ? {timeoutMs: options.tokenTimeoutMs}
            : {}),
        });
        const executor = createShopifyAdminGraphqlExecutor({
          shopDomain: config.shopDomain,
          getAccessToken,
          ...(options.fetcher ? {fetcher: options.fetcher} : {}),
          ...(options.adminTimeoutMs
            ? {timeoutMs: options.adminTimeoutMs}
            : {}),
          ...(options.now ? {now: options.now} : {}),
          ...(options.retrySleep ? {sleep: options.retrySleep} : {}),
          ...(options.retryRandom ? {random: options.retryRandom} : {}),
          logger,
          ...(config.graphqlCostDebug
            ? {
                costDebug: true,
                onCostDebug: options.onCostDebug ??
                  ((cost: Record<string, unknown>) => {
                    console.debug("Shopify GraphQL cost", JSON.stringify(cost));
                  }),
              }
            : {}),
        });
        runtime = {
          dataAccess: createProductDataAccess(executor),
          internalApiKey: config.internalApiKey,
        };
      }

      const response = await handleApiRequest(request, runtime);
      safeLog(logger, {
        event: "request_complete",
        requestId: response.headers.get("x-request-id") ?? "unknown",
        route: new URL(request.url).pathname,
        status: response.status,
        final: response.ok ? "success" : "failure",
      });
      return response;
    } catch {
      const response = internalConfigurationError();
      safeLog(logger, {
        event: "request_complete",
        requestId: response.headers.get("x-request-id") ?? "unknown",
        route: new URL(request.url).pathname,
        status: response.status,
        final: "failure",
        category: "configuration_error",
      });
      return response;
    }
  };
}

const fetchWorker = createWorkerHandler();

export default {
  fetch(request: Request, environment: WorkerEnvironment): Promise<Response> {
    return fetchWorker(request, environment);
  },
};
