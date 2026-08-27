import assert from "node:assert/strict";
import test from "node:test";

import {
  ShopifyAdminApiError,
  ShopifyAdminGraphqlError,
  ShopifyAdminHttpError,
  ShopifyAdminRetryExhaustedError,
  ShopifyAdminTimeoutError,
} from "../../shared/shopify/admin.ts";
import {handleApiRequest, type ProductApiDataAccess} from "../../server/api.ts";
import {normalizeShopDomain} from "../../server/config.ts";
import {
  createClientCredentialsTokenProvider,
  createServerAdminGraphqlExecutor,
} from "../../server/shopify.ts";

const API_KEY = "a-secure-internal-api-key-with-32-characters";

function product(id = "gid://shopify/Product/1") {
  return {
    id,
    title: "Blue Shirt",
    handle: "blue-shirt",
    status: "ACTIVE",
    vendor: "Acme",
    productType: "Shirts",
    tags: ["blue"],
    variants: [],
    variantsPageInfo: {hasNextPage: false, endCursor: null},
    metafields: [],
  };
}

function dataAccess(overrides: Partial<ProductApiDataAccess> = {}): ProductApiDataAccess {
  return {
    searchProducts: async () => ({
      products: [product()],
      pageInfo: {hasNextPage: false, endCursor: null},
    }),
    getProductBySku: async () => [],
    getProductByBarcode: async () => [],
    getProductById: async () => product(),
    getInventoryForVariant: async () => null,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://internal.example${path}`, {
    ...init,
    headers: {Authorization: `Bearer ${API_KEY}`, ...init.headers},
  });
}

test("external routes reject missing, invalid, and malformed bearer credentials", async () => {
  for (const headers of [
    undefined,
    {Authorization: "Bearer wrong"},
    {Authorization: `Basic ${API_KEY}`},
    {Authorization: "Bearer"},
  ]) {
    const unauthorized = await handleApiRequest(
      new Request("https://internal.example/api/health", {headers}),
      {dataAccess: dataAccess(), internalApiKey: API_KEY},
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(
      unauthorized.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
    assert.equal((await unauthorized.json()).error.code, "UNAUTHORIZED");
  }
});

test("valid bearer credentials authorize health requests", async () => {

  const response = await handleApiRequest(request("/api/health"), {
    dataAccess: dataAccess(),
    internalApiKey: API_KEY,
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, {status: "ok", adminApiVersion: "2026-07"});
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Shopify auth paths are outside the application API-key boundary", async () => {
  const response = await handleApiRequest(
    new Request("https://internal.example/api/auth/callback"),
    {dataAccess: dataAccess(), internalApiKey: API_KEY},
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "NOT_FOUND");
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("search normalizes filters, caps limits, and rejects unknown parameters", async () => {
  let received: unknown;
  const access = dataAccess({
    searchProducts: async (options) => {
      received = options;
      return {products: [], pageInfo: {hasNextPage: false, endCursor: null}};
    },
  });
  const response = await handleApiRequest(
    request("/api/products/search?q=%20blue%20%20shirt%20&vendor=%20Acme%20&productType=Shirts&limit=25"),
    {dataAccess: access, internalApiKey: API_KEY},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    q: "blue shirt",
    vendor: "Acme",
    productType: "Shirts",
    first: 25,
  });

  for (const path of [
    "/api/products/search",
    "/api/products/search?q=x&limit=0",
    "/api/products/search?q=x&limit=51",
    "/api/products/search?q=x&extra=true",
    "/api/products/search?q=x&q=y",
  ]) {
    const invalid = await handleApiRequest(request(path), {
      dataAccess: access,
      internalApiKey: API_KEY,
    });
    assert.equal(invalid.status, 400, path);
    assert.equal((await invalid.json()).error.code, "INVALID_INPUT");
  }
});

test("search defaults to 10 and validates opaque pagination cursors", async () => {
  const received: unknown[] = [];
  const access = dataAccess({
    searchProducts: async (options) => {
      received.push(options);
      return {products: [], pageInfo: {hasNextPage: false, endCursor: null}};
    },
  });

  const valid = await handleApiRequest(
    request("/api/products/search?q=shirt&after=eyJsYXN0X2lkIjoxMjN9"),
    {dataAccess: access, internalApiKey: API_KEY},
  );
  assert.equal(valid.status, 200);
  assert.deepEqual(received[0], {
    q: "shirt",
    after: "eyJsYXN0X2lkIjoxMjN9",
    first: 10,
  });

  for (const path of [
    "/api/products/search?q=shirt&after=%20%20",
    "/api/products/search?q=shirt&after=not%20a%20cursor",
    "/api/products/search?q=shirt&after=a&after=b",
  ]) {
    const invalid = await handleApiRequest(request(path), {
      dataAccess: access,
      internalApiKey: API_KEY,
    });
    assert.equal(invalid.status, 400, path);
    assert.equal((await invalid.json()).error.code, "INVALID_INPUT");
  }
});

test("routes normalized SKU, barcode, and product IDs", async () => {
  const calls: string[] = [];
  const access = dataAccess({
    getProductBySku: async (value) => { calls.push(`sku:${value}`); return []; },
    getProductByBarcode: async (value) => { calls.push(`barcode:${value}`); return []; },
    getProductById: async (value) => { calls.push(`id:${value}`); return product(); },
  });

  for (const path of [
    "/api/products/by-sku/SKU-001",
    "/api/products/by-barcode/0123456789012",
    "/api/products/123",
  ]) {
    const response = await handleApiRequest(request(path), {
      dataAccess: access,
      internalApiKey: API_KEY,
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls, ["sku:SKU-001", "barcode:0123456789012", "id:123"]);
});

test("routes paginated variant inventory and distinguishes not found", async () => {
  const calls: unknown[] = [];
  const access = dataAccess({
    getInventoryForVariant: async (id, options) => {
      calls.push({id, options});
      return id === "404" ? null : {
        variant: {
          id: "gid://shopify/ProductVariant/20",
          title: "Blue / Large",
          sku: "SKU-001",
          barcode: "0123456789012",
          price: "19.95",
          selectedOptions: [],
          inventoryItem: {
            id: "gid://shopify/InventoryItem/30",
            tracked: true,
            levels: [],
            pageInfo: {hasNextPage: false, endCursor: null},
          },
        },
      };
    },
  });

  const found = await handleApiRequest(
    request("/api/variants/20/inventory?limit=30&after=inventoryCursor"),
    {dataAccess: access, internalApiKey: API_KEY},
  );
  assert.equal(found.status, 200);
  assert.deepEqual(calls[0], {
    id: "20",
    options: {first: 30, after: "inventoryCursor"},
  });

  const missing = await handleApiRequest(
    request("/api/variants/404/inventory"),
    {dataAccess: access, internalApiKey: API_KEY},
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.message, "Product variant not found");

  for (const path of [
    "/api/variants/20/inventory?limit=0",
    "/api/variants/20/inventory?limit=51",
    "/api/variants/20/inventory?extra=true",
  ]) {
    const invalid = await handleApiRequest(request(path), {
      dataAccess: access,
      internalApiKey: API_KEY,
    });
    assert.equal(invalid.status, 400, path);
  }
});

test("returns stable not-found, method, and sanitized upstream errors", async () => {
  const missing = await handleApiRequest(request("/api/products/999"), {
    dataAccess: dataAccess({getProductById: async () => null}),
    internalApiKey: API_KEY,
  });
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, "NOT_FOUND");
  assert.equal(missingBody.error.details.state, "product_not_found");

  const method = await handleApiRequest(request("/api/products/search?q=x", {method: "POST"}), {
    dataAccess: dataAccess(),
    internalApiKey: API_KEY,
  });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");

  const upstream = await handleApiRequest(request("/api/products/search?q=x"), {
    dataAccess: dataAccess({
      searchProducts: async () => {
        throw new ShopifyAdminApiError("secret-token-must-not-leak");
      },
    }),
    internalApiKey: API_KEY,
  });
  const body = JSON.stringify(await upstream.json());
  assert.equal(upstream.status, 502);
  assert.match(body, /SHOPIFY_UPSTREAM_ERROR/);
  assert.doesNotMatch(body, /secret-token-must-not-leak/);
});

test("maps Shopify HTTP and GraphQL throttling to retryable sanitized errors", async () => {
  const httpThrottle = await handleApiRequest(request("/api/products/search?q=x"), {
    dataAccess: dataAccess({
      searchProducts: async () => {
        throw new ShopifyAdminHttpError(429, "Too Many Requests", "2.5");
      },
    }),
    internalApiKey: API_KEY,
  });
  const httpBody = await httpThrottle.json();
  assert.equal(httpThrottle.status, 503);
  assert.equal(httpThrottle.headers.get("retry-after"), "2.5");
  assert.equal(httpBody.error.code, "SHOPIFY_THROTTLED");
  assert.deepEqual(httpBody.error.details, {retryable: true, upstreamStatus: 429});

  const graphqlThrottle = await handleApiRequest(request("/api/products/search?q=x"), {
    dataAccess: dataAccess({
      searchProducts: async () => {
        throw new ShopifyAdminGraphqlError([{
          message: "secret diagnostic text",
          extensions: {code: "THROTTLED", requestId: "shopify-request-123"},
        }]);
      },
    }),
    internalApiKey: API_KEY,
  });
  const graphqlText = JSON.stringify(await graphqlThrottle.json());
  assert.equal(graphqlThrottle.status, 503);
  assert.equal(graphqlThrottle.headers.get("retry-after"), "1");
  assert.match(graphqlText, /THROTTLED/);
  assert.doesNotMatch(graphqlText, /shopify-request-123/);
  assert.doesNotMatch(graphqlText, /secret diagnostic text/);
});

test("maps upstream timeouts to a retryable 504 without leaking causes", async () => {
  const response = await handleApiRequest(request("/api/products/search?q=x"), {
    dataAccess: dataAccess({
      searchProducts: async () => {
        throw new ShopifyAdminTimeoutError({cause: new Error("secret timeout cause")});
      },
    }),
    internalApiKey: API_KEY,
  });
  const body = JSON.stringify(await response.json());
  assert.equal(response.status, 504);
  assert.match(body, /SHOPIFY_TIMEOUT/);
  assert.match(body, /"retryable":true/);
  assert.doesNotMatch(body, /secret timeout cause/);
});

test("maps exhausted transient retries to a sanitized temporary state", async () => {
  const response = await handleApiRequest(request("/api/products/search?q=x"), {
    dataAccess: dataAccess({
      searchProducts: async () => {
        throw new ShopifyAdminRetryExhaustedError({
          category: "graphql_internal_server_error",
          attempts: 3,
          lastError: new ShopifyAdminGraphqlError([{
            message: "secret upstream failure",
            extensions: {
              code: "INTERNAL_SERVER_ERROR",
              requestId: "internal-shopify-request-id",
            },
          }]),
          shopifyRequestIds: ["internal-shopify-request-id"],
        });
      },
    }),
    internalApiKey: API_KEY,
  });
  const body = JSON.stringify(await response.json());
  assert.equal(response.status, 503);
  assert.match(body, /TEMPORARY_UPSTREAM_FAILURE/);
  assert.match(body, /temporary_upstream_failure/);
  assert.doesNotMatch(body, /secret upstream failure|internal-shopify-request-id/);
});

test("client-credentials tokens are cached and used only in Shopify headers", async () => {
  let tokenRequests = 0;
  const tokenProvider = createClientCredentialsTokenProvider({
    shopDomain: "example.myshopify.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetcher: async (_url, init) => {
      tokenRequests += 1;
      assert.doesNotMatch(String(init?.body), /X-Shopify-Access-Token/);
      return Response.json({access_token: "shopify-secret-token", expires_in: 86399});
    },
    now: () => 1_000,
  });
  assert.equal(await tokenProvider(), "shopify-secret-token");
  assert.equal(await tokenProvider(), "shopify-secret-token");
  assert.equal(tokenRequests, 1);

  let header = "";
  const executor = createServerAdminGraphqlExecutor({
    shopDomain: "example.myshopify.com",
    getAccessToken: tokenProvider,
    fetcher: async (url, init) => {
      assert.equal(url, "https://example.myshopify.com/admin/api/2026-07/graphql.json");
      header = (init?.headers as Record<string, string>)["X-Shopify-Access-Token"];
      return Response.json({data: {shop: {id: "gid://shopify/Shop/1"}}});
    },
  });
  await executor("query Shop { shop { id } }");
  assert.equal(header, "shopify-secret-token");
});

test("server-side Shopify GraphQL calls have a bounded timeout", async () => {
  const executor = createServerAdminGraphqlExecutor({
    shopDomain: "example.myshopify.com",
    getAccessToken: async () => "token",
    timeoutMs: 5,
    sleep: async () => {},
    fetcher: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {once: true});
    }),
  });

  await assert.rejects(
    () => executor("query Shop { shop { id } }"),
    ShopifyAdminRetryExhaustedError,
  );
});

test("shop domains are normalized without permitting arbitrary hosts", () => {
  assert.equal(normalizeShopDomain("Example"), "example.myshopify.com");
  assert.equal(
    normalizeShopDomain("https://example.myshopify.com/"),
    "example.myshopify.com",
  );
  assert.throws(() => normalizeShopDomain("attacker.example.com"));
});
