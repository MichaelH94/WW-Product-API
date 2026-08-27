import type {AdminGraphqlExecutor} from "./admin.ts";
import {
  expectArray,
  expectRecord,
  parsePageInfo,
  parseProduct,
  parseVariant,
  type PageInfo,
  type Product,
  type ProductVariant,
} from "./parsers.ts";

export interface MetafieldSelector {
  namespace: string;
  key: string;
}

export type ProductSearchField =
  | "title"
  | "sku"
  | "barcode"
  | "vendor"
  | "productType";

interface ProductSearchPageOptions {
  first?: number;
  after?: string;
  includeInventoryLevels?: boolean;
}

export type ProductSearchOptions = ProductSearchPageOptions & (
  | { field: ProductSearchField; value: string }
  | {
      field?: never;
      value?: never;
      q?: string;
      vendor?: string;
      productType?: string;
    }
);

export interface ProductSearchResult {
  products: Product[];
  pageInfo: PageInfo;
}

export interface ProductDetailOptions {
  metafields?: ReadonlyArray<MetafieldSelector>;
}

export interface VariantLookupResult {
  product: Omit<Product, "variants" | "variantsPageInfo" | "metafields">;
  variant: ProductVariant;
}

export interface InventoryForVariant {
  variant: ProductVariant;
}

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  vendor
  productType
  tags`;

const VARIANT_FIELDS = `
  id
  title
  sku
  barcode
  price
  selectedOptions { name value }`;

export const SEARCH_VARIANT_LIMIT = 3;
export const VARIANT_LOOKUP_LIMIT = 25;
export const PRODUCT_DETAIL_VARIANT_LIMIT = 10;
export const INVENTORY_LEVEL_LIMIT = 20;

const INVENTORY_ITEM_SUMMARY = `
  inventoryItem {
    id
    tracked
  }`;

const INVENTORY_ITEM_WITH_LEVELS = `
  inventoryItem {
    id
    tracked
    inventoryLevels(first: ${INVENTORY_LEVEL_LIMIT}) {
      nodes {
        id
        location { id name }
        quantities(names: ["available", "on_hand"]) { name quantity }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const SEARCH_FIELDS: Record<ProductSearchField, string> = {
  title: "title",
  sku: "sku",
  barcode: "barcode",
  vendor: "vendor",
  productType: "product_type",
};

function normalizeGid(id: string, resource: "Product" | "ProductVariant"): string {
  const value = id.trim();
  if (new RegExp(`^gid://shopify/${resource}/\\d+$`).test(value)) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/${resource}/${value}`;
  throw new TypeError(`Expected a numeric ID or Shopify ${resource} GID`);
}

function metafieldSelection(selectors: ReadonlyArray<MetafieldSelector> = []): {
  query: string;
  aliases: string[];
} {
  if (selectors.length > 20) {
    throw new RangeError("At most 20 product metafields can be requested");
  }

  const aliases = selectors.map((selector, index) => {
    if (!selector.namespace.trim() || !selector.key.trim()) {
      throw new TypeError("Metafield namespace and key must not be empty");
    }
    return `metafield${index}`;
  });

  return {
    aliases,
    query: selectors.map((selector, index) => `
      ${aliases[index]}: metafield(
        namespace: ${JSON.stringify(selector.namespace)}
        key: ${JSON.stringify(selector.key)}
      ) { namespace key type jsonValue }`).join(""),
  };
}
function quoteSearchValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("Search value must not be empty");
  return `"${trimmed.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function searchQuery(field: ProductSearchField, value: string): string {
  if (!(field in SEARCH_FIELDS)) {
    throw new TypeError(`Unsupported product search field: ${String(field)}`);
  }
  return `${SEARCH_FIELDS[field]}:${quoteSearchValue(value)}`;
}

function combinedSearchQuery(options: ProductSearchOptions): string {
  if (options.field !== undefined) return searchQuery(options.field, options.value);

  const terms: string[] = [];
  if (options.q !== undefined) terms.push(quoteSearchValue(options.q));
  if (options.vendor !== undefined) {
    terms.push(`vendor:${quoteSearchValue(options.vendor)}`);
  }
  if (options.productType !== undefined) {
    terms.push(`product_type:${quoteSearchValue(options.productType)}`);
  }
  return terms.join(" ");
}

function pageSize(first: number | undefined): number {
  const value = first ?? 25;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError("first must be an integer between 1 and 100");
  }
  return value;
}

export function buildSearchProductsQuery(
  includeInventoryLevels = false,
): { query: string; aliases: string[] } {
  const inventorySelection = includeInventoryLevels
    ? INVENTORY_ITEM_WITH_LEVELS
    : INVENTORY_ITEM_SUMMARY;
  return {
    aliases: [],
    query: `query SearchProducts($query: String!, $first: Int!, $after: String) {
      products(first: $first, after: $after, query: $query) {
        nodes {
          ${PRODUCT_FIELDS}
          variants(first: ${SEARCH_VARIANT_LIMIT}) {
            nodes { ${VARIANT_FIELDS} ${inventorySelection} }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
  };
}

export function buildGetProductByIdQuery(
  metafields: ReadonlyArray<MetafieldSelector> = [],
): { query: string; aliases: string[] } {
  const selection = metafieldSelection(metafields);
  return {
    aliases: selection.aliases,
    query: `query GetProductById($id: ID!) {
      product(id: $id) {
        ${PRODUCT_FIELDS}
        variants(first: ${PRODUCT_DETAIL_VARIANT_LIMIT}) {
          nodes { ${VARIANT_FIELDS} ${INVENTORY_ITEM_WITH_LEVELS} }
          pageInfo { hasNextPage endCursor }
        }
        ${selection.query}
      }
    }`,
  };
}

export const LOOKUP_PRODUCT_VARIANTS_QUERY = `query LookupProductVariants(
  $query: String!
  $first: Int!
  $after: String
) {
  productVariants(first: $first, after: $after, query: $query) {
    nodes {
      ${VARIANT_FIELDS}
      ${INVENTORY_ITEM_SUMMARY}
      product { ${PRODUCT_FIELDS} }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const GET_INVENTORY_FOR_VARIANT_QUERY = `query GetInventoryForVariant($id: ID!) {
  productVariant(id: $id) {
    ${VARIANT_FIELDS}
    ${INVENTORY_ITEM_WITH_LEVELS}
  }
}`;

function parseProductSummary(value: unknown, path: string): VariantLookupResult["product"] {
  const product = expectRecord(value, path);
  const parsed = parseProduct({
    ...product,
    variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }, path, []);
  const { variants: _variants, variantsPageInfo: _pageInfo, metafields: _metafields, ...summary } = parsed;
  return summary;
}

async function lookupVariants(
  field: "sku" | "barcode",
  value: string,
  executor: AdminGraphqlExecutor,
): Promise<VariantLookupResult[]> {
  const data = await executor<unknown>(LOOKUP_PRODUCT_VARIANTS_QUERY, {
    query: `${field}:${quoteSearchValue(value)}`,
    first: VARIANT_LOOKUP_LIMIT,
    after: null,
  });
  const root = expectRecord(data, "data");
  const connection = expectRecord(root.productVariants, "data.productVariants");
  return expectArray(connection.nodes, "data.productVariants.nodes").map((node, index) => {
    const path = `data.productVariants.nodes[${index}]`;
    const record = expectRecord(node, path);
    return {
      product: parseProductSummary(record.product, `${path}.product`),
      variant: parseVariant(record, path),
    };
  });
}

export function createProductDataAccess(executor: AdminGraphqlExecutor) {
  return {
    async searchProducts(options: ProductSearchOptions): Promise<ProductSearchResult> {
      const built = buildSearchProductsQuery(
        options.includeInventoryLevels,
      );
      const data = await executor<unknown>(built.query, {
        query: combinedSearchQuery(options),
        first: pageSize(options.first),
        after: options.after ?? null,
      });
      const root = expectRecord(data, "data");
      const connection = expectRecord(root.products, "data.products");
      return {
        products: expectArray(connection.nodes, "data.products.nodes").map(
          (product, index) => parseProduct(product, `data.products.nodes[${index}]`, built.aliases),
        ),
        pageInfo: parsePageInfo(connection.pageInfo, "data.products.pageInfo"),
      };
    },

    async getProductById(
      id: string,
      options: ProductDetailOptions = {},
    ): Promise<Product | null> {
      const built = buildGetProductByIdQuery(options.metafields);
      const data = await executor<unknown>(built.query, {
        id: normalizeGid(id, "Product"),
      });
      const root = expectRecord(data, "data");
      return root.product === null
        ? null
        : parseProduct(root.product, "data.product", built.aliases);
    },

    getProductBySku(sku: string): Promise<VariantLookupResult[]> {
      return lookupVariants("sku", sku, executor);
    },

    getProductByBarcode(barcode: string): Promise<VariantLookupResult[]> {
      return lookupVariants("barcode", barcode, executor);
    },

    async getInventoryForVariant(id: string): Promise<InventoryForVariant | null> {
      const data = await executor<unknown>(GET_INVENTORY_FOR_VARIANT_QUERY, {
        id: normalizeGid(id, "ProductVariant"),
      });
      const root = expectRecord(data, "data");
      return root.productVariant === null
        ? null
        : { variant: parseVariant(root.productVariant, "data.productVariant") };
    },
  };
}
