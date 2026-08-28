import { ShopifyAdminResponseError } from "./admin.ts";

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface SelectedOption {
  name: string;
  value: string;
}

export interface InventoryQuantity {
  name: string;
  quantity: number;
}

export interface InventoryLevel {
  id: string;
  location: {
    id: string;
    name: string;
    active: boolean;
    address: {
      address1: string | null;
      address2: string | null;
      city: string | null;
      province: string | null;
      provinceCode: string | null;
      country: string | null;
      countryCode: string | null;
      zip: string | null;
      phone: string | null;
    };
  };
  quantities: InventoryQuantity[];
}

export interface InventoryItem {
  id: string;
  tracked: boolean;
  levels: InventoryLevel[];
  pageInfo: PageInfo | null;
}

export interface ProductVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  selectedOptions: SelectedOption[];
  inventoryItem: InventoryItem | null;
}

export interface ProductMetafield {
  namespace: string;
  key: string;
  type: string;
  value: unknown;
}

export interface ProductImage {
  mediaId: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  description: string;
  descriptionHtml: string;
  featuredImage: ProductImage | null;
  images: ProductImage[];
  imagesPageInfo: PageInfo;
  variants: ProductVariant[];
  variantsPageInfo: PageInfo;
  metafields: ProductMetafield[];
}

function fail(path: string, expected: string): never {
  throw new ShopifyAdminResponseError(
    `Invalid Shopify Admin API data at ${path}: expected ${expected}`,
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "an object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return fail(path, "an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path, "a string");
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "a boolean");
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(path, "a finite number");
  }
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return number(value, path);
}

function httpsUrl(value: unknown, path: string): string {
  const parsed = string(value, path);
  try {
    if (new URL(parsed).protocol !== "https:") return fail(path, "an HTTPS URL");
  } catch {
    return fail(path, "an HTTPS URL");
  }
  return parsed;
}

export function parsePageInfo(value: unknown, path: string): PageInfo {
  const item = record(value, path);
  return {
    hasNextPage: boolean(item.hasNextPage, `${path}.hasNextPage`),
    endCursor: nullableString(item.endCursor, `${path}.endCursor`),
  };
}

export function parseProductMedia(
  value: unknown,
  path: string,
): {images: ProductImage[]; pageInfo: PageInfo} {
  const connection = record(value, path);
  const images = array(connection.nodes, `${path}.nodes`).flatMap((node, index) => {
    const nodePath = `${path}.nodes[${index}]`;
    const media = record(node, nodePath);
    if (string(media.__typename, `${nodePath}.__typename`) !== "MediaImage") return [];
    if (media.image === null) return [];
    const image = record(media.image, `${nodePath}.image`);
    return [{
      mediaId: string(media.id, `${nodePath}.id`),
      url: httpsUrl(image.url, `${nodePath}.image.url`),
      altText: nullableString(media.alt, `${nodePath}.alt`),
      width: nullableNumber(image.width, `${nodePath}.image.width`),
      height: nullableNumber(image.height, `${nodePath}.image.height`),
    }];
  });
  return {
    images,
    pageInfo: parsePageInfo(connection.pageInfo, `${path}.pageInfo`),
  };
}

export function parseInventoryItem(
  value: unknown,
  path: string,
): InventoryItem | null {
  if (value === null) return null;
  const item = record(value, path);
  const connection = item.inventoryLevels === undefined
    ? null
    : record(item.inventoryLevels, `${path}.inventoryLevels`);

  return {
    id: string(item.id, `${path}.id`),
    tracked: boolean(item.tracked, `${path}.tracked`),
    levels: connection === null
      ? []
      : array(connection.nodes, `${path}.inventoryLevels.nodes`).map((level, index) => {
          const levelPath = `${path}.inventoryLevels.nodes[${index}]`;
          const parsedLevel = record(level, levelPath);
          const location = record(parsedLevel.location, `${levelPath}.location`);
          const address = record(location.address, `${levelPath}.location.address`);
          return {
            id: string(parsedLevel.id, `${levelPath}.id`),
            location: {
              id: string(location.id, `${levelPath}.location.id`),
              name: string(location.name, `${levelPath}.location.name`),
              active: boolean(location.isActive, `${levelPath}.location.isActive`),
              address: {
                address1: nullableString(address.address1, `${levelPath}.location.address.address1`),
                address2: nullableString(address.address2, `${levelPath}.location.address.address2`),
                city: nullableString(address.city, `${levelPath}.location.address.city`),
                province: nullableString(address.province, `${levelPath}.location.address.province`),
                provinceCode: nullableString(address.provinceCode, `${levelPath}.location.address.provinceCode`),
                country: nullableString(address.country, `${levelPath}.location.address.country`),
                countryCode: nullableString(address.countryCode, `${levelPath}.location.address.countryCode`),
                zip: nullableString(address.zip, `${levelPath}.location.address.zip`),
                phone: nullableString(address.phone, `${levelPath}.location.address.phone`),
              },
            },
            quantities: array(parsedLevel.quantities, `${levelPath}.quantities`)
              .map((quantity, quantityIndex) => {
                const quantityPath = `${levelPath}.quantities[${quantityIndex}]`;
                const parsedQuantity = record(quantity, quantityPath);
                return {
                  name: string(parsedQuantity.name, `${quantityPath}.name`),
                  quantity: number(parsedQuantity.quantity, `${quantityPath}.quantity`),
                };
              }),
          };
        }),
    pageInfo: connection === null
      ? null
      : parsePageInfo(connection.pageInfo, `${path}.inventoryLevels.pageInfo`),
  };
}

export function parseVariant(value: unknown, path: string): ProductVariant {
  const variant = record(value, path);
  return {
    id: string(variant.id, `${path}.id`),
    title: string(variant.title, `${path}.title`),
    sku: nullableString(variant.sku, `${path}.sku`),
    barcode: nullableString(variant.barcode, `${path}.barcode`),
    price: string(variant.price, `${path}.price`),
    selectedOptions: array(variant.selectedOptions, `${path}.selectedOptions`)
      .map((option, index) => {
        const optionPath = `${path}.selectedOptions[${index}]`;
        const parsedOption = record(option, optionPath);
        return {
          name: string(parsedOption.name, `${optionPath}.name`),
          value: string(parsedOption.value, `${optionPath}.value`),
        };
      }),
    inventoryItem: parseInventoryItem(
      variant.inventoryItem,
      `${path}.inventoryItem`,
    ),
  };
}

export function parseProduct(
  value: unknown,
  path: string,
  metafieldAliases: ReadonlyArray<string>,
): Product {
  const product = record(value, path);
  const variants = record(product.variants, `${path}.variants`);
  const media = parseProductMedia(product.media, `${path}.media`);

  return {
    id: string(product.id, `${path}.id`),
    title: string(product.title, `${path}.title`),
    handle: string(product.handle, `${path}.handle`),
    status: string(product.status, `${path}.status`),
    vendor: string(product.vendor, `${path}.vendor`),
    productType: string(product.productType, `${path}.productType`),
    tags: array(product.tags, `${path}.tags`).map((tag, index) =>
      string(tag, `${path}.tags[${index}]`)),
    description: string(product.description, `${path}.description`),
    descriptionHtml: string(product.descriptionHtml, `${path}.descriptionHtml`),
    featuredImage: media.images[0] ?? null,
    images: media.images,
    imagesPageInfo: media.pageInfo,
    variants: array(variants.nodes, `${path}.variants.nodes`).map(
      (variant, index) => parseVariant(variant, `${path}.variants.nodes[${index}]`),
    ),
    variantsPageInfo: parsePageInfo(
      variants.pageInfo,
      `${path}.variants.pageInfo`,
    ),
    metafields: metafieldAliases.flatMap((alias) => {
      const value = product[alias];
      if (value === null || value === undefined) return [];
      const metafield = record(value, `${path}.${alias}`);
      return [{
        namespace: string(metafield.namespace, `${path}.${alias}.namespace`),
        key: string(metafield.key, `${path}.${alias}.key`),
        type: string(metafield.type, `${path}.${alias}.type`),
        value: metafield.jsonValue,
      }];
    }),
  };
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  return record(value, path);
}

export function expectArray(value: unknown, path: string): unknown[] {
  return array(value, path);
}

export function expectString(value: unknown, path: string): string {
  return string(value, path);
}

export function expectNullableString(value: unknown, path: string): string | null {
  return nullableString(value, path);
}

export function expectBoolean(value: unknown, path: string): boolean {
  return boolean(value, path);
}

export function expectNumber(value: unknown, path: string): number {
  return number(value, path);
}
