import {handleApiRequest} from "../server/api.ts";
import {
  createClientCredentialsTokenProvider,
  createShopifyAdminGraphqlExecutor,
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
        });
        runtime = {
          dataAccess: createProductDataAccess(executor),
          internalApiKey: config.internalApiKey,
        };
      }

      return await handleApiRequest(request, runtime);
    } catch {
      return internalConfigurationError();
    }
  };
}

const fetchWorker = createWorkerHandler();

export default {
  fetch(request: Request, environment: WorkerEnvironment): Promise<Response> {
    return fetchWorker(request, environment);
  },
};
