import assert from "node:assert/strict";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import test, {after, before} from "node:test";

import {
  ADMIN_API_VERSION,
  ShopifyAdminGraphqlError,
  ShopifyAdminHttpError,
  ShopifyAdminRetryExhaustedError,
  ShopifyAdminTimeoutError,
  type AdminGraphqlExecutor,
} from "../../shared/shopify/admin.ts";
import {createProductDataAccess} from "../../shared/shopify/products.ts";
import {createApiHttpServer} from "../../server/http.ts";

const INTERNAL_API_KEY = "integration-test-api-key-with-sufficient-entropy";
const PAGE_INFO = {hasNextPage: false, endCursor: null};
const RAW_MEDIA = {
  nodes: [{
    __typename: "MediaImage",
    id: "gid://shopify/MediaImage/600",
    alt: "Blue shirt front view",
    image: {
      url: "https://cdn.shopify.com/s/files/blue-shirt.jpg",
      width: 1200,
      height: 1200,
    },
  }],
  pageInfo: PAGE_INFO,
};

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
          isActive: true,
          address: {
            address1: "100 Main Street",
            address2: null,
            city: "Chicago",
            province: "Illinois",
            provinceCode: "IL",
            country: "United States",
            countryCode: "US",
            zip: "60601",
            phone: "+1 312 555 0100",
          },
        },
        quantities: [
          {name: "available", quantity: 0},
          {name: "on_hand", quantity: 9},
          {name: "incoming", quantity: 3},
        ],
      },
      {
        id: "gid://shopify/InventoryLevel/401?inventory_item_id=300",
        location: {
          id: "gid://shopify/Location/501",
          name: "Overflow warehouse",
          isActive: false,
          address: {
            address1: "200 Overflow Road",
            address2: "Building B",
            city: "Cicero",
            province: "Illinois",
            provinceCode: "IL",
            country: "United States",
            countryCode: "US",
            zip: "60804",
            phone: null,
          },
        },
        quantities: [
          {name: "available", quantity: 4},
          {name: "on_hand", quantity: 4},
          {name: "incoming", quantity: 0},
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
  description: "A blue shirt for summer.",
  descriptionHtml: "<p>A blue shirt for summer.</p>",
  media: RAW_MEDIA,
};

const RAW_PRODUCT = {
  ...RAW_PRODUCT_SUMMARY,
  variants: {nodes: RAW_VARIANTS, pageInfo: PAGE_INFO},
};

const RAW_VARIANT_SUMMARY = {
  ...RAW_VARIANTS[0],
  inventoryItem: {
    id: RAW_INVENTORY_ITEM.id,
    tracked: RAW_INVENTORY_ITEM.tracked,
  },
};

const RAW_SEARCH_PRODUCT = {
  ...RAW_PRODUCT_SUMMARY,
  descriptionHtml: undefined,
  variants: {
    nodes: [RAW_VARIANT_SUMMARY, RAW_VARIANTS[1]],
    pageInfo: PAGE_INFO,
  },
};

type GraphqlObservation = {
  operation: string;
  variables: Record<string, unknown>;
};

const observations: GraphqlObservation[] = [];
let lastSearchDocument = "";

const shopifyExecutor: AdminGraphqlExecutor = async <TData>(
  query: string,
  variables: Record<string, unknown> = {},
) => {
  if (query.includes("SearchProducts")) {
    lastSearchDocument = query;
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
        nodes: searchQuery.includes("no-results") ? [] : [RAW_SEARCH_PRODUCT],
        pageInfo: {
          hasNextPage: !searchQuery.includes("no-results"),
          endCursor: searchQuery.includes("no-results") ? null : "cursor-next",
        },
      },
    } as TData;
  }

  if (query.includes("LookupProductVariantInventory")) {
    observations.push({operation: "LookupProductVariantInventory", variables});
    const searchQuery = String(variables.query ?? "");
    if (searchQuery === 'sku:"TRANSIENT"') {
      throw new ShopifyAdminRetryExhaustedError({
        category: "network_failure",
        attempts: 3,
        lastError: new TypeError("sensitive transient cause"),
        shopifyRequestIds: ["internal-shopify-request-id"],
      });
    }

    const exactVariant = (overrides: Record<string, unknown> = {}) => ({
      ...RAW_VARIANTS[0],
      ...overrides,
      product: RAW_PRODUCT_SUMMARY,
    });
    let nodes: Record<string, unknown>[] = [];
    if (searchQuery === 'sku:"EV1-LE"') nodes = [exactVariant({sku: "EV1-LE"})];
    if (searchQuery === 'sku:"SAMF180"') nodes = [exactVariant({sku: "SAMF180"})];
    if (searchQuery === 'sku:"SKU-ZERO"') {
      nodes = [exactVariant({
        sku: "SKU-ZERO",
        inventoryItem: {
          ...RAW_INVENTORY_ITEM,
          inventoryLevels: {
            nodes: RAW_INVENTORY_ITEM.inventoryLevels.nodes.map((level) => ({
              ...level,
              quantities: level.quantities.map((quantity) => ({...quantity, quantity: 0})),
            })),
            pageInfo: PAGE_INFO,
          },
        },
      })];
    }
    if (searchQuery === 'sku:"SKU-UNTRACKED"') {
      nodes = [exactVariant({
        sku: "SKU-UNTRACKED",
        inventoryItem: {...RAW_INVENTORY_ITEM, tracked: false},
      })];
    }
    if (searchQuery === 'sku:"SKU-DUPLICATE"') {
      nodes = [
        exactVariant({id: "gid://shopify/ProductVariant/200", sku: "SKU-DUPLICATE"}),
        exactVariant({id: "gid://shopify/ProductVariant/202", sku: "SKU-DUPLICATE"}),
      ];
    }
    if (searchQuery === 'barcode:"0012345678905"') nodes = [exactVariant()];

    return {
      productVariants: {
        nodes,
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

  if (query.includes("GetInventoryForVariant")) {
    observations.push({operation: "GetInventoryForVariant", variables});
    return {
      productVariant:
        variables.id === "gid://shopify/ProductVariant/404"
          ? null
          : RAW_VARIANTS[0],
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
    "description",
    "descriptionHtml",
    "featuredImage",
    "handle",
    "id",
    "images",
    "imagesPageInfo",
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
    "description",
    "descriptionHtml",
    "featuredImage",
    "id",
    "images",
    "imagesPageInfo",
    "productType",
    "status",
    "title",
    "vendor",
  ]);
  assert.ok(Array.isArray(value.images));
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
    for (const level of value.inventoryItem.levels) {
      assertRecord(level);
      assertRecord(level.location);
      assert.equal(typeof level.location.active, "boolean");
      assertRecord(level.location.address);
      assert.ok(Array.isArray(level.quantities));
    }
  }
}

function assertVariantLookupSchema(value: unknown): void {
  assertRecord(value);
  assert.deepEqual(Object.keys(value).sort(), [
    "hasAdditionalMatches",
    "matchCount",
    "matches",
    "state",
  ]);
  assert.equal(typeof value.state, "string");
  assert.equal(typeof value.matchCount, "number");
  assert.equal(typeof value.hasAdditionalMatches, "boolean");
  assert.ok(Array.isArray(value.matches));
}

function assertSearchProductSchema(value: unknown): void {
  assertRecord(value);
  assert.deepEqual(Object.keys(value).sort(), [
    "descriptionPreview",
    "featuredImage",
    "handle",
    "id",
    "productType",
    "status",
    "tags",
    "title",
    "variants",
    "variantsPageInfo",
    "vendor",
  ]);
  assert.ok(Array.isArray(value.tags));
  assert.ok(Array.isArray(value.variants));
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

test('broad "snowboards" search is lightweight and normalized', async () => {
  observations.length = 0;
  const response = await request(
    "/api/products/search?q=%20snowboards%20&limit=10",
  );
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assertRecord(payload.data);
  assert.deepEqual(Object.keys(payload.data).sort(), ["pageInfo", "products"]);
  assert.ok(Array.isArray(payload.data.products));
  assert.equal(payload.data.products.length, 1);
  assertSearchProductSchema(payload.data.products[0]);
  assert.equal(payload.data.products[0].descriptionPreview,
    "A blue shirt for summer.");
  assert.equal(payload.data.products[0].featuredImage.url,
    "https://cdn.shopify.com/s/files/blue-shirt.jpg");
  assert.match(lastSearchDocument, /variants\(first: 3\)/);
  assert.doesNotMatch(lastSearchDocument, /inventoryLevels/);

  assert.deepEqual(observations.at(-1), {
    operation: "SearchProducts",
    variables: {
      query: '"snowboards"',
      first: 10,
      after: null,
    },
  });
});

for (const sku of ["EV1-LE", "SAMF180"]) {
test(`performs inventory-enriched exact SKU lookup for ${sku} in one operation`, async () => {
  observations.length = 0;
  const response = await request(`/api/products/by-sku/${sku}`);
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assertVariantLookupSchema(payload.data);
  assertRecord(payload.data);
  assert.equal(payload.data.state, "found_with_inventory");
  const matches = payload.data.matches as Array<Record<string, unknown>>;
  assert.equal(matches.length, 1);
  assertRecord(matches[0].variant);
  assertRecord(matches[0].product);
  assert.equal(matches[0].product.description, "A blue shirt for summer.");
  assert.equal(matches[0].product.descriptionHtml,
    "<p>A blue shirt for summer.</p>");
  assert.equal((matches[0].product.images as unknown[]).length, 1);
  assert.equal(matches[0].variant.sku, sku);
  assertRecord(matches[0].variant.inventoryItem);
  const levels = matches[0].variant.inventoryItem.levels as Array<Record<string, unknown>>;
  assert.equal(levels.length, 2);
  assert.equal(levels[0].available, 0);
  assert.equal(levels[0].on_hand, 9);
  assert.equal(levels[0].incoming, 3);
  assert.deepEqual(observations.at(-1), {
    operation: "LookupProductVariantInventory",
    variables: {query: `sku:"${sku}"`},
  });
});
}

test("performs exact barcode lookup without losing leading zeroes", async () => {
  observations.length = 0;
  const response = await request("/api/products/by-barcode/0012345678905");
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assertVariantLookupSchema(payload.data);
  assertRecord(payload.data);
  const matches = payload.data.matches as Array<Record<string, unknown>>;
  assertRecord(matches[0]);
  assertRecord(matches[0].variant);
  assertRecord(matches[0].product);
  assert.equal(matches[0].product.featuredImage.url,
    "https://cdn.shopify.com/s/files/blue-shirt.jpg");
  assert.equal(
    matches[0].variant.barcode,
    "0012345678905",
  );
  assert.deepEqual(observations.at(-1), {
    operation: "LookupProductVariantInventory",
    variables: {query: 'barcode:"0012345678905"'},
  });
});

test("exact lookup reports zero, untracked, duplicate, missing, and transient states", async () => {
  for (const [sku, state] of [
    ["SKU-ZERO", "found_zero_inventory"],
    ["SKU-UNTRACKED", "inventory_not_tracked"],
    ["SKU-MISSING", "product_not_found"],
  ] as const) {
    const response = await request(`/api/products/by-sku/${sku}`);
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assertRecord(payload.data);
    assert.equal(payload.data.state, state);
  }

  const duplicateResponse = await request("/api/products/by-sku/SKU-DUPLICATE");
  const duplicatePayload = await readJson(duplicateResponse);
  assertRecord(duplicatePayload.data);
  assert.equal(duplicatePayload.data.state, "ambiguous");
  assert.equal(duplicatePayload.data.matchCount, 2);

  const transientResponse = await request("/api/products/by-sku/TRANSIENT");
  const transientPayload = await readJson(transientResponse);
  assert.equal(transientResponse.status, 503);
  assertRecord(transientPayload.error);
  assertRecord(transientPayload.error.details);
  assert.equal(transientPayload.error.details.state, "temporary_upstream_failure");
  assert.doesNotMatch(JSON.stringify(transientPayload), /sensitive|internal-shopify/);
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
  assert.equal(product.description, "A blue shirt for summer.");
  assert.equal((product.images as unknown[]).length, 1);
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
        active: true,
        address: {
          address1: "100 Main Street",
          address2: null,
          city: "Chicago",
          province: "Illinois",
          provinceCode: "IL",
          country: "United States",
          countryCode: "US",
          zip: "60601",
          phone: "+1 312 555 0100",
        },
      },
      quantities: [
        {name: "available", quantity: 0},
        {name: "on_hand", quantity: 9},
        {name: "incoming", quantity: 3},
      ],
    },
    {
      id: "gid://shopify/InventoryLevel/401?inventory_item_id=300",
      location: {
        id: "gid://shopify/Location/501",
        name: "Overflow warehouse",
        active: false,
        address: {
          address1: "200 Overflow Road",
          address2: "Building B",
          city: "Cicero",
          province: "Illinois",
          provinceCode: "IL",
          country: "United States",
          countryCode: "US",
          zip: "60804",
          phone: null,
        },
      },
      quantities: [
        {name: "available", quantity: 4},
        {name: "on_hand", quantity: 4},
        {name: "incoming", quantity: 0},
      ],
    },
  ]);
  assert.deepEqual(observations.at(-1), {
    operation: "GetProductById",
    variables: {
      id: "gid://shopify/Product/100",
      mediaFirst: 10,
      mediaAfter: null,
    },
  });
});

test("retrieves paginated inventory for an identified variant", async () => {
  observations.length = 0;
  const response = await request(
    "/api/variants/200/inventory?limit=25&after=inventoryCursor",
  );
  assert.equal(response.status, 200);
  const payload = await readJson(response);
  assertSuccessEnvelope(response, payload);
  assertRecord(payload.data);
  assertVariantSchema(payload.data.variant);
  assertRecord(payload.data.variant);
  assertRecord(payload.data.variant.inventoryItem);
  assert.equal(payload.data.state, "found_with_inventory");
  const levels = payload.data.variant.inventoryItem.levels as Array<Record<string, unknown>>;
  assert.equal(levels.length, 2);
  assert.deepEqual(levels[0]?.quantities, [
    {name: "available", quantity: 0},
    {name: "on_hand", quantity: 9},
    {name: "incoming", quantity: 3},
  ]);
  assert.deepEqual(observations.at(-1), {
    operation: "GetInventoryForVariant",
    variables: {
      id: "gid://shopify/ProductVariant/200",
      first: 25,
      after: "inventoryCursor",
    },
  });

  const missing = await request("/api/variants/404/inventory");
  assert.equal(missing.status, 404);
  assertErrorEnvelope(missing, await readJson(missing), "NOT_FOUND");
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
  assert.deepEqual(skuPayload.data, {
    state: "product_not_found",
    matchCount: 0,
    hasAdditionalMatches: false,
    matches: [],
  });

  const barcodeResponse = await request("/api/products/by-barcode/999");
  assert.equal(barcodeResponse.status, 200);
  const barcodePayload = await readJson(barcodeResponse);
  assertSuccessEnvelope(barcodeResponse, barcodePayload);
  assert.deepEqual(barcodePayload.data, {
    state: "product_not_found",
    matchCount: 0,
    hasAdditionalMatches: false,
    matches: [],
  });
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
    "/api/variants/200/inventory?limit=51",
    "/api/variants/200/inventory?unexpected=true",
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
    "/api/variants/200/inventory",
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
