import assert from "node:assert/strict";
import test from "node:test";

import {
  createClientCredentialsTokenProvider,
} from "../../server/shopify.ts";
import {
  createWorkerHandler,
  type WorkerHandlerOptions,
} from "../../worker/index.ts";
import type {WorkerEnvironment} from "../../worker/config.ts";

const API_KEY = "worker-integration-api-key-with-32-characters";
const ENVIRONMENT: WorkerEnvironment = {
  SHOPIFY_SHOP: "example.myshopify.com",
  SHOPIFY_CLIENT_ID: "shopify-client-id",
  SHOPIFY_CLIENT_SECRET: "shopify-client-secret",
  INTERNAL_API_KEY: API_KEY,
};

function request(path: string, authorization = `Bearer ${API_KEY}`): Request {
  return new Request(`https://api.example.test${path}`, {
    headers: {Authorization: authorization},
  });
}

function emptySearchResponse(): Response {
  return Response.json({
    data: {
      products: {
        nodes: [],
        pageInfo: {hasNextPage: false, endCursor: null},
      },
    },
  });
}

test("Worker preserves API bearer authentication and health response", async () => {
  const handler = createWorkerHandler();

  const unauthorized = await handler(
    new Request("https://api.example.test/api/health"),
    ENVIRONMENT,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "UNAUTHORIZED");

  const authorized = await handler(request("/api/health"), ENVIRONMENT);
  assert.equal(authorized.status, 200);
  assert.deepEqual((await authorized.json()).data, {
    status: "ok",
    adminApiVersion: "2026-07",
  });
});

test("Worker obtains a server-side token and caches it across API requests", async () => {
  let tokenRequests = 0;
  let graphqlRequests = 0;
  const observedTokens: string[] = [];
  const options: WorkerHandlerOptions = {
    fetcher: async (url, init) => {
      if (url.endsWith("/admin/oauth/access_token")) {
        tokenRequests += 1;
        assert.equal(init?.method, "POST");
        assert.match(String(init?.body), /grant_type=client_credentials/);
        return Response.json({
          access_token: "shopify-token-must-remain-server-side",
          expires_in: 86399,
        });
      }

      graphqlRequests += 1;
      assert.equal(
        url,
        "https://example.myshopify.com/admin/api/2026-07/graphql.json",
      );
      const headers = init?.headers as Record<string, string>;
      observedTokens.push(headers["X-Shopify-Access-Token"]);
      assert.equal(headers["Shopify-GraphQL-Cost-Debug"], undefined);
      const operation = JSON.parse(String(init?.body)).query as string;
      assert.match(operation, /query SearchProducts/);
      assert.doesNotMatch(operation, /\bmutation\b/i);
      return emptySearchResponse();
    },
  };
  const handler = createWorkerHandler(options);

  for (const query of ["shirt", "hat"]) {
    const response = await handler(
      request(`/api/products/search?q=${query}`),
      ENVIRONMENT,
    );
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(await response.json());
    assert.doesNotMatch(serialized, /shopify-token-must-remain-server-side/);
    assert.doesNotMatch(serialized, /shopify-client-secret/);
  }

  assert.equal(tokenRequests, 1);
  assert.equal(graphqlRequests, 2);
  assert.deepEqual(observedTokens, [
    "shopify-token-must-remain-server-side",
    "shopify-token-must-remain-server-side",
  ]);
});

test("Worker enables cost diagnostics only when requested and never returns them", async () => {
  let observedHeader: string | undefined;
  let observedCost: Record<string, unknown> | undefined;
  const handler = createWorkerHandler({
    onCostDebug: (cost) => {
      observedCost = cost;
    },
    fetcher: async (url, init) => {
      if (url.endsWith("/admin/oauth/access_token")) {
        return Response.json({access_token: "server-only-token", expires_in: 86399});
      }

      observedHeader = (init?.headers as Record<string, string>)[
        "Shopify-GraphQL-Cost-Debug"
      ];
      return Response.json({
        data: {
          products: {
            nodes: [],
            pageInfo: {hasNextPage: false, endCursor: null},
          },
        },
        extensions: {
          cost: {
            requestedQueryCost: 42,
            fields: [{path: ["products"], requestedTotalCost: 42}],
          },
        },
      });
    },
  });

  const response = await handler(
    request("/api/products/search?q=snowboards"),
    {...ENVIRONMENT, SHOPIFY_GRAPHQL_COST_DEBUG: "1"},
  );
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 200);
  assert.equal(observedHeader, "1");
  assert.equal(observedCost?.requestedQueryCost, 42);
  assert.doesNotMatch(body, /requestedQueryCost|requestedTotalCost|fields/);
});

test("client-credentials cache refreshes before Shopify token expiry", async () => {
  let now = 1_000;
  let tokenRequests = 0;
  const provider = createClientCredentialsTokenProvider({
    shopDomain: "example.myshopify.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => now,
    fetcher: async () => {
      tokenRequests += 1;
      return Response.json({
        access_token: `token-${tokenRequests}`,
        expires_in: 120,
      });
    },
  });

  assert.equal(await provider(), "token-1");
  now = 60_000;
  assert.equal(await provider(), "token-1");
  now = 62_000;
  assert.equal(await provider(), "token-2");
  assert.equal(tokenRequests, 2);
});

test("Worker invalidates a rejected token and retries Shopify authentication once", async () => {
  let tokenRequests = 0;
  let graphqlRequests = 0;
  const graphqlTokens: string[] = [];
  const handler = createWorkerHandler({
    fetcher: async (url, init) => {
      if (url.endsWith("/admin/oauth/access_token")) {
        tokenRequests += 1;
        return Response.json({
          access_token: `shopify-token-${tokenRequests}`,
          expires_in: 86399,
        });
      }

      graphqlRequests += 1;
      graphqlTokens.push(
        (init?.headers as Record<string, string>)["X-Shopify-Access-Token"],
      );
      return graphqlRequests === 1
        ? new Response(null, {status: 401, statusText: "Unauthorized"})
        : emptySearchResponse();
    },
  });

  const response = await handler(
    request("/api/products/search?q=shirt"),
    ENVIRONMENT,
  );
  assert.equal(response.status, 200);
  assert.equal(tokenRequests, 2);
  assert.equal(graphqlRequests, 2);
  assert.deepEqual(graphqlTokens, ["shopify-token-1", "shopify-token-2"]);
});

test("Worker retries authentication only once and sanitizes repeated failures", async () => {
  let tokenRequests = 0;
  let graphqlRequests = 0;
  const handler = createWorkerHandler({
    fetcher: async (url) => {
      if (url.endsWith("/admin/oauth/access_token")) {
        tokenRequests += 1;
        return Response.json({
          access_token: `secret-rejected-token-${tokenRequests}`,
          expires_in: 86399,
        });
      }
      graphqlRequests += 1;
      return new Response("secret upstream response", {
        status: 401,
        statusText: "Unauthorized",
      });
    },
  });

  const response = await handler(
    request("/api/products/search?q=shirt"),
    ENVIRONMENT,
  );
  const body = JSON.stringify(await response.json());
  assert.equal(response.status, 502);
  assert.equal(tokenRequests, 2);
  assert.equal(graphqlRequests, 2);
  assert.match(body, /SHOPIFY_UPSTREAM_ERROR/);
  assert.doesNotMatch(body, /secret-rejected-token|secret upstream response/);
});

test("Worker reports invalid bindings without leaking their values", async () => {
  const handler = createWorkerHandler();
  const response = await handler(request("/api/health"), {
    ...ENVIRONMENT,
    SHOPIFY_SHOP: "attacker.example.com",
    SHOPIFY_CLIENT_SECRET: "configuration-secret-must-not-leak",
  });
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 500);
  assert.match(body, /INTERNAL_ERROR/);
  assert.doesNotMatch(body, /attacker|configuration-secret/);
});
