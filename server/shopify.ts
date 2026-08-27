import {
  ADMIN_API_VERSION,
  createAdminGraphqlExecutor,
  ShopifyAdminApiError,
  type AdminGraphqlExecutor,
  type FetchLike,
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
}): AdminGraphqlExecutor {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const endpoint = `https://${options.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return createAdminGraphqlExecutor(async (_input, init) => {
    const send = async (accessToken: string) => fetcher(endpoint, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        "X-Shopify-Access-Token": accessToken,
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
  }, endpoint);
}

// Retain the Node entry point's existing import while the shared transport is
// also used by Cloudflare Workers.
export const createServerAdminGraphqlExecutor = createShopifyAdminGraphqlExecutor;
