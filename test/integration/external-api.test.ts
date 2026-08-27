import assert from "node:assert/strict";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import test, {after, before} from "node:test";

import {
  ADMIN_API_VERSION,
  ShopifyAdminGraphqlError,
  ShopifyAdminHttpError,
  ShopifyAdminTimeoutError,
  type AdminGraphqlExecutor,
} from "../../shared/shopify/admin.ts";
import {createProductDataAccess} from "../../shared/shopify/products.ts";
import {createApiHttpServer} from "../../server/http.ts";

const INTERNAL_API_KEY = "integration-test-api-key-with-sufficient-entropy";
const PAGE_INFO = {hasNextPage: false, endCursor: null};

const RAW_INVENTORY_ITEM = {
  id: "gid://shopify/InventoryItem/300",
  tracked: true,
  inventoryLevels: {
    nodes: [
      {
        id: "gid://shopify/InventoryLevel/400?inventory_item_id=300",
        location: {
          id: "gid://shopify/Location/500",
          name: "Main warehouse",
        },
        quantities: [
          {name: "available", quantity: 0},
          {name: "on_hand", quantity: 9},
        ],
      },
      {
        id: "gid://shopify/InventoryLevel/401?inventory_item_id=300",
        location: {
          id: "gid://shopify/Location/501",
          name: "Overflow warehouse",
        },
        quantities: [
          {name: "available", quantity: 4},
          {name: "on_hand", quantity: 4},
        ],
      },
    ],
    pageInfo: PAGE_INFO,
  },
};

const RAW_VARIANTS = [
  {
    id: "gid://shopify/ProductVariant/200",
    title: "Blue / Large",
    sku: "SKU-001",
    barcode: "0012345678905",
    price: "19.9500",
    selectedOptions: [
      {name: "Color", value: "Blue"},
      {name: "Size", value: "Large"},
    ],
    inventoryItem: RAW_INVENTORY_ITEM,
  },
  {
    id: "gid://shopify/ProductVariant/201",
    title: "Uncoded sample",
    sku: null,
    barcode: null,
    price: "0.00",
    selectedOptions: [],
    inventoryItem: null,
  },
];

const RAW_PRODUCT_SUMMARY = {
  id: "gid://shopify/Product/100",
  title: "Blue Shirt",
  handle: "blue-shirt",
  status: "ACTIVE",
  vendor: "Acme",
  productType: "Shirts",
  tags: ["blue", "summer"],
};

const RAW_PRODUCT = {
  ...RAW_PRODUCT_SUMMARY,
  variants: {nodes: RAW_VARIANTS, pageInfo: PAGE_INFO},
};

type GraphqlObservation = {
  operation: string;
  variables: Record<string, unknown>;
};

const observations: GraphqlObservation[] = [];

const shopifyExecutor: AdminGraphqlExecutor = async <TData>(
  query: string,
  variables: Record<string, unknown> = {},
) => {
  if (query.includes("SearchProducts")) {
    observations.push({operation: "SearchProducts", variables});
    const searchQuery = String(variables.query ?? "");

    if (searchQuery.includes("upstream-error")) {
      throw new ShopifyAdminHttpError(500, "sensitive Shopify response body");
    }

    if (searchQuery.includes("throttle")) {
      throw new ShopifyAdminGraphqlError([
        {
          message: "sensitive Shopify throttling detail",
          extensions: {
            code: "THROTTLED",
            requestId: "shopify-integration-request",
          },
        },
      ]);
    }

    if (searchQuery.includes("timeout")) {
      throw new ShopifyAdminTimeoutError({
        cause: new Error("sensitive transport failure"),
      });
    }

    return {
      products: {
        nodes: searchQuery.includes("no-results") ? [] : [RAW_PRODUCT],
        pageInfo: {
          hasNextPage: !searchQuery.includes("no-results"),
          endCursor: searchQuery.includes("no-results") ? null : "cursor-next",
        },
      },
    } as TData;
  }

  if (query.includes("LookupProductVariants")) {
    observations.push({operation: "LookupProductVariants", variables});
    const searchQuery = String(variables.query ?? "");
    const matches =
      searchQuery === 'sku:"SKU-001"' ||
      searchQuery === 'barcode:"0012345678905"';

    return {
      productVariants: {
        nodes: matches
          ? [{...RAW_VARIANTS[0], product: RAW_PRODUCT_SUMMARY}]
          : [],
        pageInfo: PAGE_INFO,
      },
    } as TData;
  }

  if (query.includes("GetProductById")) {
    observations.push({operation: "GetProductById", variables});
    return {
      product:
        variables.id === "gid://shopify/Product/404" ? null : RAW_PRODUCT,
    } as TData;
  }

  throw new Error("Unexpected GraphQL operation in integration test");
};

let server: Server;
let baseUrl = "";

before(async () => {
  server = createApiHttpServer({
    dataAccess: createProductDataAccess(shopifyExecutor),
    internalApiKey: INTERNAL_API_KEY,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function request(
  path: string,
  options: RequestInit & {authenticated?: boolean} = {},
): Promise<Response> {
  const {authenticated = true, ...requestOptions} = options;
  const headers = new Headers(requestOptions.headers);

  if (authenticated) {
    headers.set("Authorization", `Bearer ${INTERNAL_API_KEY}`);
  }

  return fetch(`${baseUrl}${path}`, {...requestOptions, headers});
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json(?:;|$)/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as Record<string, unknown>;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

function assertNoGraphqlConnections(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoGraphqlConnections);
    return;
  }

  if (value && typeof value === "object") {
    assert.equal("edges" in value, false);
    assert.equal("nodes" in value, false);
    Object.values(value).forEach(assertNoGraphqlConnections);
  }
}

function assertSuccessEnvelope(
  response: Response,
  payload: Record<string, unknown>,
): asserts payload is {data: unknown; meta: Record<string, unknown>} {
  assert.deepEqual(Object.keys(payload).sort(), ["data", "meta"]);
  assertRecord(payload.meta);
  assert.deepEqual(Object.keys(payload.meta).sort(), ["requestId"]);
  assert.match(String(payload.meta.requestId), /^[0-9a-f-]{36}$/i);
  assert.equal(response.headers.get("x-request-id"), payload.meta.requestId);
  assertNoGraphqlConnections(payload);
}

function assertErrorEnvelope(
  response: Response,
  payload: Record<string, unknown>,
  expectedCode: string,
): asserts payload is {
  error: Record<string, unknown>;
  meta: Record<string, unknown>;
} {
  assert.deepEqual(Object.keys(payload).sort(), ["error", "meta"]);
  assertRecord(payload.error);
  assert.equal(payload.error.code, expectedCode);
  assert.equal(typeof payload.error.message, "string");
  assertRecord(payload.meta);
  assert.equal(response.headers.get("x-request-id"), payload.meta.requestId);
}

function assertProductSchema(value: unknown): void {
  assertRecord(value);
  assert.deepEqual(Object.keys(value).sort(), [
    "handle",
    "id",
    "metafields",
    "productType",
    "status",
    "tags",
    "title",
    "variants",
    "variantsPageInfo",
    "vendor",
  ]);
  assert.equal(typeof value.id, "string");
  assert.equal(typeof value.title, "string");
  assert.ok(Array.isArray(value.tags));
  assert.ok(Array.isArray(value.variants));

  for (const variant of value.variants) {
    assertVariantSchema(variant);
  }
}

function assertProductSummarySchema(value: unknown): void {
  assertRecord(value);
  assert.deepEqual(Object.keys(value).sort(), [
    "handle",
    "id",
    "productType",
    "status",
    "tags",
    "title",
    "vendor",
  ]);
  assert.ok(Array.isArray(value.tags));
}

function assertVariantSchema(value: unknown): void {
  assertRecord(value);
  assert.deepEqual(Object.keys(value).sort(), [
    "barcode",
    "id",
    "inventoryItem",
    "price",
    "selectedOptions",
    "sku",
    "title",
  ]);
  assert.ok(
    value.sku === null || typeof value.sku === "string",
    "sku must be an exact string or explicit null",
  );
  assert.ok(
    value.barcode === null || typeof value.barcode === "string",
    "barcode must be an exact string or explicit null",
  );
  assert.equal(typeof value.price, "string");
  assert.ok(Array.isArray(value.selectedOptions));

  if (value.inventoryItem !== null) {
    assertRecord(value.inventoryItem);
    assert.deepEqual(Object.keys(value.inventoryItem).sort(), [
      "id",
      "levels",
      "pageInfo",
      "tracked",
    ]);
    assert.ok(Array.isArray(value.inventoryItem.levels));
  }
}

function assertVariantLookupSchema(value: unknown): void {
  assertRecord(value);
  assert.deepEqual(Object.keys(value).sort(), ["product", "variant"]);
  assertProductSummarySchema(value.product);
  assertVariantSchema(value.variant);
}

test("requires a valid bearer credential without affecting health", async () => {
  const missingResponse = await request("/api/products/search?q=shirt", {
    authenticated: false,
  });
  assert.equal(missingResponse.status, 401);
  assert.equal(missingResponse.headers.get("www-authenticate"), "Bearer");
  assertErrorEnvelope(
    missingResponse,
    await readJson(missingResponse),
    "UNAUTHORIZED",
  );

  const invalidResponse = await request("/api/products/search?q=shirt", {
    authenticated: false,
    headers: {Authorization: "Bearer definitely-not-the-api-key"},
  });
  assert.equal(invalidResponse.status, 401);
  assertErrorEnvelope(
    invalidResponse,
    await readJson(invalidResponse),
    "UNAUTHORIZED",
  );

  const healthResponse = await request("/api/health");
  assert.equal(healthResponse.status, 200);
  const healthPayload = await readJson(healthResponse);
  assertSuccessEnvelope(healthResponse, healthPayload);
  assert.deepEqual(healthPayload.data, {
    status: "ok",
    adminApiVersion: ADMIN_API_VERSION,
  });
});

test("searches products and normalizes filters at the HTTP boundary", async () => {
  observations.length = 0;
  const response = await request(
    "/api/products/search?q=%20blue%20shirt%20&vendor=%20Acme%20&productType=Shirts&limit=10",
  );
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assertRecord(payload.data);
  assert.deepEqual(Object.keys(payload.data).sort(), ["pageInfo", "products"]);
  assert.ok(Array.isArray(payload.data.products));
  assert.equal(payload.data.products.length, 1);
  assertProductSchema(payload.data.products[0]);

  assert.deepEqual(observations.at(-1), {
    operation: "SearchProducts",
    variables: {
      query: '"blue shirt" vendor:"Acme" product_type:"Shirts"',
      first: 10,
      after: null,
    },
  });
});

test("performs exact SKU lookup and preserves the SKU", async () => {
  observations.length = 0;
  const response = await request("/api/products/by-sku/SKU-001");
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assert.ok(Array.isArray(payload.data));
  assertVariantLookupSchema(payload.data[0]);
  assertRecord(payload.data[0]);
  assertRecord(payload.data[0].variant);
  assert.equal(payload.data[0].variant.sku, "SKU-001");
  assert.deepEqual(observations.at(-1), {
    operation: "LookupProductVariants",
    variables: {query: 'sku:"SKU-001"', first: 100, after: null},
  });
});

test("performs exact barcode lookup without losing leading zeroes", async () => {
  observations.length = 0;
  const response = await request("/api/products/by-barcode/0012345678905");
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assert.ok(Array.isArray(payload.data));
  assertVariantLookupSchema(payload.data[0]);
  assertRecord(payload.data[0]);
  assertRecord(payload.data[0].variant);
  assert.equal(
    payload.data[0].variant.barcode,
    "0012345678905",
  );
  assert.deepEqual(observations.at(-1), {
    operation: "LookupProductVariants",
    variables: {query: 'barcode:"0012345678905"', first: 100, after: null},
  });
});

test("looks up a product and returns exact inventory quantities by location", async () => {
  observations.length = 0;
  const response = await request("/api/products/100");
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assertRecord(payload.data);
  assertProductSchema(payload.data);

  const product = payload.data;
  const variants = product.variants as Array<Record<string, unknown>>;
  assert.equal(variants[0].price, "19.9500");
  assert.equal(variants[1].sku, null);
  assert.equal(variants[1].barcode, null);
  assert.equal(variants[1].inventoryItem, null);

  const inventoryItem = variants[0].inventoryItem as Record<string, unknown>;
  assert.deepEqual(inventoryItem.levels, [
    {
      id: "gid://shopify/InventoryLevel/400?inventory_item_id=300",
      location: {
        id: "gid://shopify/Location/500",
        name: "Main warehouse",
      },
      quantities: [
        {name: "available", quantity: 0},
        {name: "on_hand", quantity: 9},
      ],
    },
    {
      id: "gid://shopify/InventoryLevel/401?inventory_item_id=300",
      location: {
        id: "gid://shopify/Location/501",
        name: "Overflow warehouse",
      },
      quantities: [
        {name: "available", quantity: 4},
        {name: "on_hand", quantity: 4},
      ],
    },
  ]);
  assert.deepEqual(observations.at(-1), {
    operation: "GetProductById",
    variables: {id: "gid://shopify/Product/100"},
  });
});

test("distinguishes missing products from empty exact-match results", async () => {
  const productResponse = await request("/api/products/404");
  assert.equal(productResponse.status, 404);
  assertErrorEnvelope(
    productResponse,
    await readJson(productResponse),
    "NOT_FOUND",
  );

  const skuResponse = await request("/api/products/by-sku/UNKNOWN");
  assert.equal(skuResponse.status, 200);
  const skuPayload = await readJson(skuResponse);
  assertSuccessEnvelope(skuResponse, skuPayload);
  assert.deepEqual(skuPayload.data, []);

  const barcodeResponse = await request("/api/products/by-barcode/999");
  assert.equal(barcodeResponse.status, 200);
  const barcodePayload = await readJson(barcodeResponse);
  assertSuccessEnvelope(barcodeResponse, barcodePayload);
  assert.deepEqual(barcodePayload.data, []);
});

test("rejects malformed query, pagination, path, and method inputs", async () => {
  const malformedPaths = [
    "/api/products/search",
    "/api/products/search?q=shirt&limit=0",
    "/api/products/search?q=shirt&limit=51",
    "/api/products/search?q=shirt&after=%20bad%20cursor%20",
    "/api/products/search?q=one&q=two",
    "/api/products/search?q=shirt&unexpected=true",
    "/api/products/by-sku/%E0%A4%A",
  ];

  for (const path of malformedPaths) {
    const response = await request(path);
    assert.equal(response.status, 400, path);
    assertErrorEnvelope(response, await readJson(response), "INVALID_INPUT");
  }

  const methodResponse = await request("/api/products/search?q=shirt", {
    method: "POST",
  });
  assert.equal(methodResponse.status, 405);
  assertErrorEnvelope(
    methodResponse,
    await readJson(methodResponse),
    "METHOD_NOT_ALLOWED",
  );
});

test("maps Shopify upstream failures without leaking response bodies or causes", async () => {
  const cases = [
    {
      query: "upstream-error",
      status: 502,
      code: "SHOPIFY_UPSTREAM_ERROR",
      forbidden: "sensitive Shopify response body",
    },
    {
      query: "throttle",
      status: 503,
      code: "SHOPIFY_THROTTLED",
      forbidden: "sensitive Shopify throttling detail",
    },
    {
      query: "timeout",
      status: 504,
      code: "SHOPIFY_TIMEOUT",
      forbidden: "sensitive transport failure",
    },
  ];

  for (const scenario of cases) {
    const response = await request(
      `/api/products/search?q=${encodeURIComponent(scenario.query)}`,
    );
    assert.equal(response.status, scenario.status);
    const payload = await readJson(response);
    assertErrorEnvelope(response, payload, scenario.code);
    assert.equal(JSON.stringify(payload).includes(scenario.forbidden), false);

    if (scenario.code === "SHOPIFY_THROTTLED") {
      assert.equal(response.headers.get("retry-after"), "1");
      assert.deepEqual(payload.error.details, {
        retryable: true,
        shopifyCodes: ["THROTTLED"],
        shopifyRequestIds: ["shopify-integration-request"],
      });
    }
  }
});

test("keeps response schemas consistent across successful endpoint families", async () => {
  const paths = [
    "/api/products/search?q=shirt",
    "/api/products/by-sku/SKU-001",
    "/api/products/by-barcode/0012345678905",
    "/api/products/100",
  ];

  for (const path of paths) {
    const response = await request(path);
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assertSuccessEnvelope(response, payload);

    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("accessToken"), false);
    assert.equal(serialized.includes("session"), false);
    assert.equal(serialized.includes(INTERNAL_API_KEY), false);
  }
});
