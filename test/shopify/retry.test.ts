import assert from "node:assert/strict";
import test from "node:test";

import {
  ShopifyAdminApiError,
  ShopifyAdminGraphqlError,
  ShopifyAdminRetryExhaustedError,
  type FetchLike,
} from "../../shared/shopify/admin.ts";
import {createProductDataAccess} from "../../shared/shopify/products.ts";
import {createShopifyAdminGraphqlExecutor} from "../../server/shopify.ts";

const QUERY = "query ReadShop { shop { id } }";
const CONTEXT = {requestId: "request-123", route: "/api/products/search"};

function success(cost?: Record<string, unknown>): Response {
  return Response.json({
    data: {shop: {id: "gid://shopify/Shop/1"}},
    ...(cost ? {extensions: {cost}} : {}),
  });
}

function graphqlError(code: string, requestId = "shopify-request-1"): Response {
  return Response.json({
    errors: [{
      message: "sensitive upstream detail",
      extensions: {code, requestId},
    }],
  });
}

function retryingExecutor(options: {
  fetcher: FetchLike;
  sleeps?: number[];
  logs?: Record<string, unknown>[];
  now?: () => number;
}) {
  return createShopifyAdminGraphqlExecutor({
    shopDomain: "example.myshopify.com",
    getAccessToken: Object.assign(async () => "server-only-token", {
      invalidate: () => {},
    }),
    fetcher: options.fetcher,
    sleep: async (milliseconds) => {
      options.sleeps?.push(milliseconds);
    },
    random: () => 0,
    logger: (event) => options.logs?.push(event),
    ...(options.now ? {now: options.now} : {}),
  });
}

test("succeeds on the first read attempt without backoff", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const executor = retryingExecutor({
    sleeps,
    fetcher: async () => {
      attempts += 1;
      return success();
    },
  });

  assert.equal((await executor<{shop: {id: string}}>(QUERY, {}, CONTEXT)).shop.id,
    "gid://shopify/Shop/1");
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test("retries a network failure and returns a later success", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const executor = retryingExecutor({
    sleeps,
    fetcher: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("temporary network failure");
      return success();
    },
  });

  await executor(QUERY, {}, CONTEXT);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [200]);
});

test("stops after three repeated transient failures", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const executor = retryingExecutor({
    sleeps,
    fetcher: async () => {
      attempts += 1;
      throw new TypeError("temporary network failure");
    },
  });

  await assert.rejects(
    () => executor(QUERY, {}, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof ShopifyAdminRetryExhaustedError);
      assert.equal(error.attempts, 3);
      assert.equal(error.category, "network_failure");
      return true;
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [200, 500]);
});

test("respects Retry-After for HTTP 429 before succeeding", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const executor = retryingExecutor({
    sleeps,
    fetcher: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, {
            status: 429,
            headers: {"Retry-After": "2", "X-Request-Id": "shopify-http-1"},
          })
        : success();
    },
  });

  await executor(QUERY, {}, CONTEXT);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

for (const status of [502, 503, 504]) {
  test(`retries transient HTTP ${status}`, async () => {
    let attempts = 0;
    const executor = retryingExecutor({
      fetcher: async () => {
        attempts += 1;
        return attempts === 1 ? new Response(null, {status}) : success();
      },
    });

    await executor(QUERY, {}, CONTEXT);
    assert.equal(attempts, 2);
  });
}

for (const code of ["THROTTLED", "INTERNAL_SERVER_ERROR"]) {
  test(`retries GraphQL ${code} returned with HTTP 200 and then succeeds`, async () => {
    let attempts = 0;
    const logs: Record<string, unknown>[] = [];
    const executor = retryingExecutor({
      logs,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1 ? graphqlError(code) : success();
      },
    });

    await executor(QUERY, {}, CONTEXT);
    assert.equal(attempts, 2);
    const failure = logs.find(({event}) => event === "shopify_upstream_failure");
    assert.deepEqual(failure?.shopifyRequestIds, ["shopify-request-1"]);
  });
}

for (const code of ["ACCESS_DENIED", "MAX_COST_EXCEEDED"]) {
  test(`does not retry GraphQL ${code}`, async () => {
    let attempts = 0;
    const executor = retryingExecutor({
      fetcher: async () => {
        attempts += 1;
        return graphqlError(code);
      },
    });

    await assert.rejects(
      () => executor(QUERY, {}, CONTEXT),
      ShopifyAdminGraphqlError,
    );
    assert.equal(attempts, 1);
  });
}

test("does not retry malformed GraphQL", async () => {
  let attempts = 0;
  const executor = retryingExecutor({
    fetcher: async () => {
      attempts += 1;
      return graphqlError("GRAPHQL_VALIDATION_FAILED");
    },
  });

  await assert.rejects(() => executor(QUERY, {}, CONTEXT), ShopifyAdminGraphqlError);
  assert.equal(attempts, 1);
});

test("does not retry invalid client credentials", async () => {
  let credentialRequests = 0;
  const executor = createShopifyAdminGraphqlExecutor({
    shopDomain: "example.myshopify.com",
    getAccessToken: Object.assign(async () => {
      credentialRequests += 1;
      throw new ShopifyAdminApiError(
        "Shopify client-credentials request failed with HTTP 401",
      );
    }, {invalidate: () => {}}),
    fetcher: async () => success(),
    sleep: async () => {},
    logger: () => {},
  });

  await assert.rejects(() => executor(QUERY, {}, CONTEXT), ShopifyAdminApiError);
  assert.equal(credentialRequests, 1);
});

test("uses cost capacity metadata before an expensive follow-up", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const executor = retryingExecutor({
    sleeps,
    now: () => 1_000,
    fetcher: async () => {
      attempts += 1;
      return success({
        requestedQueryCost: 100,
        actualQueryCost: 100,
        throttleStatus: {currentlyAvailable: 0, restoreRate: 50},
      });
    },
  });

  await executor(QUERY, {}, CONTEXT);
  await executor(QUERY, {}, CONTEXT);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

function rawVariant(options: {tracked: boolean; levels: unknown[]}) {
  return {
    id: "gid://shopify/ProductVariant/20",
    title: "Default",
    sku: "SAMF180",
    barcode: null,
    price: "10.00",
    selectedOptions: [],
    inventoryItem: {
      id: "gid://shopify/InventoryItem/30",
      tracked: options.tracked,
      inventoryLevels: {
        nodes: options.levels,
        pageInfo: {hasNextPage: false, endCursor: null},
      },
    },
  };
}

function rawLevel(available: number) {
  return {
    id: "gid://shopify/InventoryLevel/40?inventory_item_id=30",
    location: {
      id: "gid://shopify/Location/50",
      name: "Main",
      isActive: true,
      address: {
        address1: null,
        address2: null,
        city: null,
        province: null,
        provinceCode: null,
        country: null,
        countryCode: null,
        zip: null,
        phone: null,
      },
    },
    quantities: [
      {name: "available", quantity: available},
      {name: "on_hand", quantity: available},
      {name: "incoming", quantity: 0},
    ],
  };
}

test("product not found is returned once without retrying", async () => {
  let attempts = 0;
  const api = createProductDataAccess(async <T>() => {
    attempts += 1;
    return {productVariant: null} as T;
  });

  assert.equal(await api.getInventoryForVariant("20"), null);
  assert.equal(attempts, 1);
});

test("distinguishes zero inventory, untracked inventory, and empty levels", async () => {
  const responses = [rawVariant({tracked: true, levels: [rawLevel(0)]}),
    rawVariant({tracked: false, levels: []}),
    rawVariant({tracked: true, levels: []})];
  const api = createProductDataAccess(async <T>() => ({
    productVariant: responses.shift(),
  }) as T);

  assert.equal((await api.getInventoryForVariant("20"))?.state,
    "found_zero_inventory");
  assert.equal((await api.getInventoryForVariant("20"))?.state,
    "inventory_not_tracked");
  assert.equal((await api.getInventoryForVariant("20"))?.state,
    "no_inventory_levels");
});

test("exact SAMF180 lookup retries a transient Shopify failure and returns inventory", async () => {
  let attempts = 0;
  const executor = retryingExecutor({
    fetcher: async () => {
      attempts += 1;
      if (attempts === 1) return graphqlError("INTERNAL_SERVER_ERROR");
      return Response.json({
        data: {
          productVariants: {
            nodes: [{
              ...rawVariant({tracked: true, levels: [rawLevel(4)]}),
              product: {
                id: "gid://shopify/Product/10",
                title: "Example",
                status: "ACTIVE",
                vendor: "Acme",
                productType: "Parts",
                description: "Example part",
                descriptionHtml: "<p>Example part</p>",
                media: {
                  nodes: [],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              },
            }],
            pageInfo: {hasNextPage: false},
          },
        },
      });
    },
  });
  const api = createProductDataAccess(executor);

  const result = await api.getProductBySku("SAMF180", {
    requestId: "request-samf180",
    route: "/api/products/by-sku/SAMF180",
  });

  assert.equal(attempts, 2);
  assert.equal(result.state, "found_with_inventory");
  assert.equal(result.matches[0]?.variant.sku, "SAMF180");
  assert.equal(result.matches[0]?.variant.inventoryItem?.levels[0]?.available, 4);
});
