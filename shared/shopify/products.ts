import type {
  AdminGraphqlExecutor,
  ShopifyRequestContext,
} from "./admin.ts";
import {
  expectArray,
  expectBoolean,
  expectNullableString,
  expectNumber,
  expectRecord,
  expectString,
  parsePageInfo,
  parseProduct,
  parseProductMedia,
  parseVariant,
  type PageInfo,
  type Product,
  type ProductImage,
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
  products: ProductSearchItem[];
  pageInfo: PageInfo;
}

export interface ProductSearchItem {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  descriptionPreview: string;
  featuredImage: ProductImage | null;
  variants: ProductVariant[];
  variantsPageInfo: PageInfo;
}

export interface ProductDetailOptions {
  metafields?: ReadonlyArray<MetafieldSelector>;
  mediaFirst?: number;
  mediaAfter?: string;
}

export type InventoryResultState =
  | "found_with_inventory"
  | "found_zero_inventory"
  | "inventory_not_tracked"
  | "no_inventory_levels";

export interface ExactInventoryLevel {
  id: string;
  location: {
    id: string;
    name: string;
  };
  available: number | null;
  on_hand: number | null;
  incoming: number | null;
}

export interface ExactVariantLookupMatch {
  product: {
    id: string;
    title: string;
    status: string;
    vendor: string;
    productType: string;
    description: string;
    descriptionHtml: string;
    featuredImage: ProductImage | null;
    images: ProductImage[];
    imagesPageInfo: PageInfo;
  };
  variant: {
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: string;
    inventoryItem: {
      id: string;
      tracked: boolean;
      levels: ExactInventoryLevel[];
      pageInfo: PageInfo;
    } | null;
  };
  inventoryState: InventoryResultState;
}

export interface ExactVariantLookupResult {
  state: InventoryResultState | "product_not_found" | "ambiguous";
  matchCount: number;
  hasAdditionalMatches: boolean;
  matches: ExactVariantLookupMatch[];
}

export interface InventoryForVariant {
  state: InventoryResultState;
  variant: ProductVariant;
}

export interface InventoryPageOptions {
  first?: number;
  after?: string;
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
export const EXACT_VARIANT_LOOKUP_LIMIT = 2;
export const EXACT_LOOKUP_INVENTORY_LEVEL_LIMIT = 20;
export const PRODUCT_DETAIL_VARIANT_LIMIT = 10;
export const INVENTORY_LEVEL_LIMIT = 20;
export const MAX_INVENTORY_LEVEL_LIMIT = 50;
export const BROAD_SEARCH_IMAGE_LIMIT = 1;
export const EXACT_LOOKUP_IMAGE_LIMIT = 5;
export const PRODUCT_DETAIL_IMAGE_LIMIT = 10;
export const DESCRIPTION_PREVIEW_LIMIT = 320;

const INVENTORY_ITEM_SUMMARY = `
  inventoryItem {
    id
    tracked
  }`;

function productMedia(first: string, after = ""): string {
  return `media(first: ${first}${after}, query: "media_type:IMAGE", sortKey: POSITION) {
    nodes {
      __typename
      id
      alt
      ... on MediaImage { image { url width height } }
    }
    pageInfo { hasNextPage endCursor }
  }`;
}

function inventoryItemWithLevels(first: string, after = ""): string {
  return `
  inventoryItem {
    id
    tracked
    inventoryLevels(first: ${first}${after}, includeInactive: true) {
      nodes {
        id
        location {
          id
          name
          isActive
          address {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCode
            zip
            phone
          }
        }
        quantities(names: ["available", "on_hand", "incoming"]) {
          name
          quantity
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

const INVENTORY_ITEM_WITH_LEVELS = inventoryItemWithLevels(
  String(INVENTORY_LEVEL_LIMIT),
);

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

export function buildSearchProductsQuery(): { query: string; aliases: string[] } {
  return {
    aliases: [],
    query: `query SearchProducts($query: String!, $first: Int!, $after: String) {
      products(first: $first, after: $after, query: $query) {
        nodes {
          ${PRODUCT_FIELDS}
          description
          ${productMedia(String(BROAD_SEARCH_IMAGE_LIMIT))}
          variants(first: ${SEARCH_VARIANT_LIMIT}) {
            nodes { ${VARIANT_FIELDS} ${INVENTORY_ITEM_SUMMARY} }
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
    query: `query GetProductById($id: ID!, $mediaFirst: Int!, $mediaAfter: String) {
      product(id: $id) {
        ${PRODUCT_FIELDS}
        description
        descriptionHtml
        ${productMedia("$mediaFirst", ", after: $mediaAfter")}
        variants(first: ${PRODUCT_DETAIL_VARIANT_LIMIT}) {
          nodes { ${VARIANT_FIELDS} ${INVENTORY_ITEM_WITH_LEVELS} }
          pageInfo { hasNextPage endCursor }
        }
        ${selection.query}
      }
    }`,
  };
}

export const LOOKUP_PRODUCT_VARIANTS_QUERY = `query LookupProductVariantInventory(
  $query: String!
) {
  productVariants(first: ${EXACT_VARIANT_LOOKUP_LIMIT}, query: $query) {
    nodes {
      id
      title
      sku
      barcode
      price
      inventoryItem {
        id
        tracked
        inventoryLevels(first: ${EXACT_LOOKUP_INVENTORY_LEVEL_LIMIT}, includeInactive: true) {
          nodes {
            id
            location { id name }
            quantities(names: ["available", "on_hand", "incoming"]) {
              name
              quantity
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      product {
        id
        title
        status
        vendor
        productType
        description
        descriptionHtml
        ${productMedia(String(EXACT_LOOKUP_IMAGE_LIMIT))}
      }
    }
    pageInfo { hasNextPage }
  }
}`;

export const GET_INVENTORY_FOR_VARIANT_QUERY = `query GetInventoryForVariant(
  $id: ID!
  $first: Int!
  $after: String
) {
  productVariant(id: $id) {
    ${VARIANT_FIELDS}
    ${inventoryItemWithLevels("$first", ", after: $after")}
  }
}`;

function parseExactQuantity(
  quantities: unknown[],
  name: "available" | "on_hand" | "incoming",
  path: string,
): number | null {
  for (let index = 0; index < quantities.length; index += 1) {
    const quantityPath = `${path}[${index}]`;
    const quantity = expectRecord(quantities[index], quantityPath);
    if (expectString(quantity.name, `${quantityPath}.name`) === name) {
      return expectNumber(quantity.quantity, `${quantityPath}.quantity`);
    }
  }
  return null;
}

function parseExactLookupMatch(
  value: unknown,
  path: string,
): ExactVariantLookupMatch {
  const variant = expectRecord(value, path);
  const product = expectRecord(variant.product, `${path}.product`);
  const media = parseProductMedia(product.media, `${path}.product.media`);
  const rawItem = variant.inventoryItem;
  let inventoryItem: ExactVariantLookupMatch["variant"]["inventoryItem"] = null;

  if (rawItem !== null) {
    const item = expectRecord(rawItem, `${path}.inventoryItem`);
    const levels = expectRecord(
      item.inventoryLevels,
      `${path}.inventoryItem.inventoryLevels`,
    );
    inventoryItem = {
      id: expectString(item.id, `${path}.inventoryItem.id`),
      tracked: expectBoolean(item.tracked, `${path}.inventoryItem.tracked`),
      levels: expectArray(levels.nodes, `${path}.inventoryItem.inventoryLevels.nodes`)
        .map((rawLevel, index) => {
          const levelPath = `${path}.inventoryItem.inventoryLevels.nodes[${index}]`;
          const level = expectRecord(rawLevel, levelPath);
          const location = expectRecord(level.location, `${levelPath}.location`);
          const quantities = expectArray(level.quantities, `${levelPath}.quantities`);
          return {
            id: expectString(level.id, `${levelPath}.id`),
            location: {
              id: expectString(location.id, `${levelPath}.location.id`),
              name: expectString(location.name, `${levelPath}.location.name`),
            },
            available: parseExactQuantity(quantities, "available", `${levelPath}.quantities`),
            on_hand: parseExactQuantity(quantities, "on_hand", `${levelPath}.quantities`),
            incoming: parseExactQuantity(quantities, "incoming", `${levelPath}.quantities`),
          };
        }),
      pageInfo: parsePageInfo(
        levels.pageInfo,
        `${path}.inventoryItem.inventoryLevels.pageInfo`,
      ),
    };
  }

  const parsed: ExactVariantLookupMatch = {
    product: {
      id: expectString(product.id, `${path}.product.id`),
      title: expectString(product.title, `${path}.product.title`),
      status: expectString(product.status, `${path}.product.status`),
      vendor: expectString(product.vendor, `${path}.product.vendor`),
      productType: expectString(product.productType, `${path}.product.productType`),
      description: expectString(product.description, `${path}.product.description`),
      descriptionHtml: expectString(product.descriptionHtml, `${path}.product.descriptionHtml`),
      featuredImage: media.images[0] ?? null,
      images: media.images,
      imagesPageInfo: media.pageInfo,
    },
    variant: {
      id: expectString(variant.id, `${path}.id`),
      title: expectString(variant.title, `${path}.title`),
      sku: expectNullableString(variant.sku, `${path}.sku`),
      barcode: expectNullableString(variant.barcode, `${path}.barcode`),
      price: expectString(variant.price, `${path}.price`),
      inventoryItem,
    },
    inventoryState: "inventory_not_tracked",
  };
  parsed.inventoryState = exactInventoryResultState(parsed);
  return parsed;
}

async function lookupVariants(
  field: "sku" | "barcode",
  value: string,
  executor: AdminGraphqlExecutor,
  context?: ShopifyRequestContext,
): Promise<ExactVariantLookupResult> {
  const data = await executor<unknown>(LOOKUP_PRODUCT_VARIANTS_QUERY, {
    query: `${field}:${quoteSearchValue(value)}`,
  }, context);
  const root = expectRecord(data, "data");
  const connection = expectRecord(root.productVariants, "data.productVariants");
  const matches = expectArray(connection.nodes, "data.productVariants.nodes").map((node, index) => {
    const path = `data.productVariants.nodes[${index}]`;
    return parseExactLookupMatch(node, path);
  });
  const pageInfo = expectRecord(connection.pageInfo, "data.productVariants.pageInfo");
  const hasAdditionalMatches = expectBoolean(
    pageInfo.hasNextPage,
    "data.productVariants.pageInfo.hasNextPage",
  );
  return {
    state: matches.length === 0
      ? "product_not_found"
      : matches.length > 1 || hasAdditionalMatches
      ? "ambiguous"
      : matches[0].inventoryState,
    matchCount: matches.length,
    hasAdditionalMatches,
    matches,
  };
}

export function createProductDataAccess(executor: AdminGraphqlExecutor) {
  return {
    async searchProducts(
      options: ProductSearchOptions,
      context?: ShopifyRequestContext,
    ): Promise<ProductSearchResult> {
      const built = buildSearchProductsQuery();
      const data = await executor<unknown>(built.query, {
        query: combinedSearchQuery(options),
        first: pageSize(options.first),
        after: options.after ?? null,
      }, context);
      const root = expectRecord(data, "data");
      const connection = expectRecord(root.products, "data.products");
      return {
        products: expectArray(connection.nodes, "data.products.nodes").map(
          (product, index) => parseSearchProduct(product, `data.products.nodes[${index}]`),
        ),
        pageInfo: parsePageInfo(connection.pageInfo, "data.products.pageInfo"),
      };
    },

    async getProductById(
      id: string,
      options: ProductDetailOptions = {},
      context?: ShopifyRequestContext,
    ): Promise<Product | null> {
      const built = buildGetProductByIdQuery(options.metafields);
      const data = await executor<unknown>(built.query, {
        id: normalizeGid(id, "Product"),
        mediaFirst: productDetailMediaSize(options.mediaFirst),
        mediaAfter: options.mediaAfter ?? null,
      }, context);
      const root = expectRecord(data, "data");
      return root.product === null
        ? null
        : parseProduct(root.product, "data.product", built.aliases);
    },

    getProductBySku(
      sku: string,
      context?: ShopifyRequestContext,
    ): Promise<ExactVariantLookupResult> {
      return lookupVariants("sku", sku, executor, context);
    },

    getProductByBarcode(
      barcode: string,
      context?: ShopifyRequestContext,
    ): Promise<ExactVariantLookupResult> {
      return lookupVariants("barcode", barcode, executor, context);
    },

    async getInventoryForVariant(
      id: string,
      options: InventoryPageOptions = {},
      context?: ShopifyRequestContext,
    ): Promise<InventoryForVariant | null> {
      const data = await executor<unknown>(GET_INVENTORY_FOR_VARIANT_QUERY, {
        id: normalizeGid(id, "ProductVariant"),
        first: inventoryPageSize(options.first),
        after: options.after ?? null,
      }, context);
      const root = expectRecord(data, "data");
      if (root.productVariant === null) return null;
      const variant = parseVariant(root.productVariant, "data.productVariant");
      return {state: inventoryResultState(variant), variant};
    },
  };
}

function parseSearchProduct(value: unknown, path: string): ProductSearchItem {
  const product = expectRecord(value, path);
  const variants = expectRecord(product.variants, `${path}.variants`);
  const media = parseProductMedia(product.media, `${path}.media`);
  return {
    id: expectString(product.id, `${path}.id`),
    title: expectString(product.title, `${path}.title`),
    handle: expectString(product.handle, `${path}.handle`),
    status: expectString(product.status, `${path}.status`),
    vendor: expectString(product.vendor, `${path}.vendor`),
    productType: expectString(product.productType, `${path}.productType`),
    tags: expectArray(product.tags, `${path}.tags`).map((tag, index) =>
      expectString(tag, `${path}.tags[${index}]`)),
    descriptionPreview: truncateDescription(
      expectString(product.description, `${path}.description`),
    ),
    featuredImage: media.images[0] ?? null,
    variants: expectArray(variants.nodes, `${path}.variants.nodes`).map(
      (variant, index) => parseVariant(variant, `${path}.variants.nodes[${index}]`),
    ),
    variantsPageInfo: parsePageInfo(variants.pageInfo, `${path}.variants.pageInfo`),
  };
}

function truncateDescription(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= DESCRIPTION_PREVIEW_LIMIT) return value;
  return `${characters.slice(0, DESCRIPTION_PREVIEW_LIMIT - 3).join("")}...`;
}

function productDetailMediaSize(first: number | undefined): number {
  const value = first ?? PRODUCT_DETAIL_IMAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > PRODUCT_DETAIL_IMAGE_LIMIT) {
    throw new RangeError(
      `mediaFirst must be an integer between 1 and ${PRODUCT_DETAIL_IMAGE_LIMIT}`,
    );
  }
  return value;
}

function inventoryResultState(
  variant: ProductVariant,
): InventoryForVariant["state"] {
  const item = variant.inventoryItem;
  if (item === null || !item.tracked) return "inventory_not_tracked";
  if (item.levels.length === 0) return "no_inventory_levels";
  const available = item.levels.flatMap(({quantities}) =>
    quantities.filter(({name}) => name === "available").map(({quantity}) => quantity));
  return available.some((quantity) => quantity > 0)
    ? "found_with_inventory"
    : "found_zero_inventory";
}

function exactInventoryResultState(
  match: ExactVariantLookupMatch,
): InventoryResultState {
  const item = match.variant.inventoryItem;
  if (item === null || !item.tracked) return "inventory_not_tracked";
  if (item.levels.length === 0) return "no_inventory_levels";
  return item.levels.some(({available}) => available !== null && available > 0)
    ? "found_with_inventory"
    : "found_zero_inventory";
}

function inventoryPageSize(first: number | undefined): number {
  const value = first ?? INVENTORY_LEVEL_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_INVENTORY_LEVEL_LIMIT) {
    throw new RangeError(
      `first must be an integer between 1 and ${MAX_INVENTORY_LEVEL_LIMIT}`,
    );
  }
  return value;
}
