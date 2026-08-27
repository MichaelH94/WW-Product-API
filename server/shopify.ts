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

export function createClientCredentialsTokenProvider(options: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  fetcher?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): () => Promise<string> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let token: string | null = null;
  let expiresAt = 0;
  let pending: Promise<string> | null = null;

  return async () => {
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
}

export function createServerAdminGraphqlExecutor(options: {
  shopDomain: string;
  getAccessToken: () => Promise<string>;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): AdminGraphqlExecutor {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const endpoint = `https://${options.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return createAdminGraphqlExecutor(async (_input, init) => {
    const accessToken = await options.getAccessToken();
    return fetcher(endpoint, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        "X-Shopify-Access-Token": accessToken,
      },
    });
  });
}
