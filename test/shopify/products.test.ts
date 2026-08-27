import assert from "node:assert/strict";
import test from "node:test";

import { ShopifyAdminResponseError } from "../../shared/shopify/admin.ts";
import {
  GET_INVENTORY_FOR_VARIANT_QUERY,
  LOOKUP_PRODUCT_VARIANTS_QUERY,
  buildGetProductByIdQuery,
  buildSearchProductsQuery,
  createProductDataAccess,
} from "../../shared/shopify/products.ts";
import {
  IS_PARTNER_DEVELOPMENT_STORE_QUERY,
  isPartnerDevelopmentStore,
} from "../../shared/shopify/shop.ts";

const pageInfo = { hasNextPage: false, endCursor: null };

function inventoryItem(withLevels = true) {
  return {
    id: "gid://shopify/InventoryItem/30",
    tracked: true,
    ...(withLevels ? {
      inventoryLevels: {
        nodes: [{
          id: "gid://shopify/InventoryLevel/40?inventory_item_id=30",
          location: {
            id: "gid://shopify/Location/50",
            name: "Main",
            isActive: true,
            address: {
              address1: "123 Warehouse Way",
              address2: null,
              city: "Chicago",
              province: "Illinois",
              provinceCode: "IL",
              country: "United States",
              countryCode: "US",
              zip: "60601",
              phone: null,
            },
          },
          quantities: [
            { name: "available", quantity: 7 },
            { name: "on_hand", quantity: 9 },
            { name: "incoming", quantity: 2 },
          ],
        }],
        pageInfo,
      },
    } : {}),
  };
}

function variant(withLevels = true) {
  return {
    id: "gid://shopify/ProductVariant/20",
    title: "Blue / Large",
    sku: "SKU-001",
    barcode: "0123456789012",
    price: "19.95",
    selectedOptions: [
      { name: "Color", value: "Blue" },
      { name: "Size", value: "Large" },
    ],
    inventoryItem: inventoryItem(withLevels),
  };
}

function product(withLevels = true) {
  return {
    id: "gid://shopify/Product/10",
    title: "Example Shirt",
    handle: "example-shirt",
    status: "ACTIVE",
    vendor: "Example Vendor",
    productType: "Shirts",
    tags: ["summer", "blue"],
    variants: { nodes: [variant(withLevels)], pageInfo },
    metafield0: {
      namespace: "custom",
      key: "material",
      type: "single_line_text_field",
      jsonValue: "Cotton",
    },
  };
}

test("parses product detail, variants, inventory, locations, and metafields", async () => {
  let variables: Record<string, unknown> | undefined;
  const api = createProductDataAccess(async <T>(_query: string, input = {}) => {
    variables = input;
    return { product: product() } as T;
  });

  const result = await api.getProductById("10", {
    metafields: [{ namespace: "custom", key: "material" }],
  });

  assert.equal(variables?.id, "gid://shopify/Product/10");
  assert.equal(result?.title, "Example Shirt");
  assert.equal(result?.variants[0]?.sku, "SKU-001");
  assert.deepEqual(result?.variants[0]?.selectedOptions[0], {
    name: "Color",
    value: "Blue",
  });
  assert.equal(result?.variants[0]?.inventoryItem?.levels[0]?.location.name, "Main");
  assert.deepEqual(result?.variants[0]?.inventoryItem?.levels[0]?.quantities, [
    { name: "available", quantity: 7 },
    { name: "on_hand", quantity: 9 },
    { name: "incoming", quantity: 2 },
  ]);
  assert.deepEqual(
    result?.variants[0]?.inventoryItem?.levels[0]?.location,
    {
      id: "gid://shopify/Location/50",
      name: "Main",
      active: true,
      address: {
        address1: "123 Warehouse Way",
        address2: null,
        city: "Chicago",
        province: "Illinois",
        provinceCode: "IL",
        country: "United States",
        countryCode: "US",
        zip: "60601",
        phone: null,
      },
    },
  );
  assert.deepEqual(result?.metafields, [{
    namespace: "custom",
    key: "material",
    type: "single_line_text_field",
    value: "Cotton",
  }]);
});

test("builds an escaped field-specific product search and parses summary inventory", async () => {
  let variables: Record<string, unknown> | undefined;
  const api = createProductDataAccess(async <T>(_query: string, input = {}) => {
    variables = input;
    return {
      products: {
        nodes: [product(false)],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
    } as T;
  });

  const result = await api.searchProducts({
    field: "title",
    value: 'Blue "Shirt" \\ Classic',
    first: 10,
  });

  assert.equal(variables?.query, 'title:"Blue \\"Shirt\\" \\\\ Classic"');
  assert.equal(variables?.first, 10);
  assert.equal(result.products[0]?.variants[0]?.inventoryItem?.levels.length, 0);
  assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "cursor-1" });
});

test("lists products without attaching inventory levels to broad results", async () => {
  let query = "";
  let variables: Record<string, unknown> | undefined;
  const api = createProductDataAccess(async <T>(operation: string, input = {}) => {
    query = operation;
    variables = input;
    return {
      products: { nodes: [product(false)], pageInfo },
    } as T;
  });

  const result = await api.searchProducts({
    first: 10,
  });

  assert.equal(variables?.query, "");
  assert.equal(variables?.first, 10);
  assert.match(query, /variants\(first: 3\)/);
  assert.doesNotMatch(query, /inventoryLevels/);
  assert.deepEqual(result.products[0]?.variants[0]?.inventoryItem?.levels, []);
});

test("combines normalized free-text, vendor, and product-type search filters", async () => {
  let variables: Record<string, unknown> | undefined;
  const api = createProductDataAccess(async <T>(_query: string, input = {}) => {
    variables = input;
    return {products: {nodes: [], pageInfo}} as T;
  });

  await api.searchProducts({
    q: "blue shirt",
    vendor: "Acme",
    productType: "Shirts",
    first: 10,
  });

  assert.equal(
    variables?.query,
    '"blue shirt" vendor:"Acme" product_type:"Shirts"',
  );
});

test("SKU and barcode lookups return every matching variant with its product", async () => {
  const searches: string[] = [];
  const api = createProductDataAccess(async <T>(_query: string, input = {}) => {
    searches.push(String(input.query));
    const item = variant();
    return {
      productVariants: {
        nodes: [{ ...item, product: product() }],
        pageInfo,
      },
    } as T;
  });

  const bySku = await api.getProductBySku("SKU-001");
  const byBarcode = await api.getProductByBarcode("0123456789012");

  assert.deepEqual(searches, [
    'sku:"SKU-001"',
    'barcode:"0123456789012"',
  ]);
  assert.equal(bySku[0]?.product.id, "gid://shopify/Product/10");
  assert.equal(byBarcode[0]?.variant.barcode, "0123456789012");
  assert.doesNotMatch(LOOKUP_PRODUCT_VARIANTS_QUERY, /inventoryLevels/);
});

test("gets inventory by numeric variant ID and returns null when absent", async () => {
  const ids: unknown[] = [];
  const variables: Record<string, unknown>[] = [];
  let found = true;
  const api = createProductDataAccess(async <T>(_query: string, input = {}) => {
    ids.push(input.id);
    variables.push(input);
    return { productVariant: found ? variant() : null } as T;
  });

  const result = await api.getInventoryForVariant("20", {
    first: 12,
    after: "inventory-cursor",
  });
  found = false;
  const missing = await api.getInventoryForVariant("gid://shopify/ProductVariant/21");

  assert.deepEqual(ids, [
    "gid://shopify/ProductVariant/20",
    "gid://shopify/ProductVariant/21",
  ]);
  assert.deepEqual(variables[0], {
    id: "gid://shopify/ProductVariant/20",
    first: 12,
    after: "inventory-cursor",
  });
  assert.equal(variables[1]?.first, 20);
  assert.equal(variables[1]?.after, null);
  assert.equal(result?.variant.inventoryItem?.levels[0]?.quantities[0]?.quantity, 7);
  assert.equal(result?.state, "found_with_inventory");
  assert.equal(missing, null);
});

test("rejects invalid IDs, pagination, metafield selectors, and response shapes", async () => {
  const api = createProductDataAccess(async <T>() => ({
    products: { nodes: [{ id: 123 }], pageInfo },
  }) as T);

  await assert.rejects(() => api.getProductById("not-an-id"), TypeError);
  await assert.rejects(
    () => api.searchProducts({ field: "vendor", value: "", first: 1 }),
    TypeError,
  );
  await assert.rejects(
    () => api.searchProducts({ field: "vendor", value: "Acme", first: 101 }),
    RangeError,
  );
  await assert.rejects(
    () => api.getInventoryForVariant("20", {first: 51}),
    RangeError,
  );
  await assert.rejects(
    () => api.searchProducts({ field: "invalid" as "title", value: "shirt" }),
    TypeError,
  );
  assert.throws(
    () => buildGetProductByIdQuery([{ namespace: "", key: "material" }]),
    TypeError,
  );
  await assert.rejects(
    () => api.searchProducts({ field: "title", value: "shirt" }),
    ShopifyAdminResponseError,
  );
});

test("all data-access operations are GraphQL queries, never mutations", () => {
  const operations = [
    buildSearchProductsQuery().query,
    buildGetProductByIdQuery([{ namespace: "custom", key: "material" }]).query,
    LOOKUP_PRODUCT_VARIANTS_QUERY,
    GET_INVENTORY_FOR_VARIANT_QUERY,
    IS_PARTNER_DEVELOPMENT_STORE_QUERY,
  ];

  for (const operation of operations) {
    assert.match(operation, /^query\s/);
    assert.doesNotMatch(operation, /\bmutation\b/i);
  }
});

test("uses conservative connection limits for search, detail, and inventory", () => {
  assert.match(buildSearchProductsQuery().query, /variants\(first: 3\)/);
  assert.doesNotMatch(buildSearchProductsQuery().query, /inventoryLevels/);
  assert.match(buildGetProductByIdQuery().query, /variants\(first: 10\)/);
  assert.match(
    buildGetProductByIdQuery().query,
    /inventoryLevels\(first: 20, includeInactive: true\)/,
  );
  assert.match(
    GET_INVENTORY_FOR_VARIANT_QUERY,
    /inventoryLevels\(first: \$first, after: \$after, includeInactive: true\)/,
  );
  assert.match(GET_INVENTORY_FOR_VARIANT_QUERY, /isActive/);
  assert.match(GET_INVENTORY_FOR_VARIANT_QUERY, /address\s*\{/);
  assert.match(
    GET_INVENTORY_FOR_VARIANT_QUERY,
    /quantities\(names: \["available", "on_hand", "incoming"\]\)/,
  );
  assert.doesNotMatch(GET_INVENTORY_FOR_VARIANT_QUERY, /\n\s+available\s*\n/);
});

test("recognizes only a confirmed partner development store", async () => {
  const development = await isPartnerDevelopmentStore(async <T>() => ({
    shop: {plan: {partnerDevelopment: true}},
  }) as T);
  const production = await isPartnerDevelopmentStore(async <T>() => ({
    shop: {plan: {partnerDevelopment: false}},
  }) as T);

  assert.equal(development, true);
  assert.equal(production, false);
  await assert.rejects(
    () => isPartnerDevelopmentStore(async <T>() => ({
      shop: {plan: {partnerDevelopment: "yes"}},
    }) as T),
    ShopifyAdminResponseError,
  );
});
