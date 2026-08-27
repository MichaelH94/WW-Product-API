export function normalizeShopDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!value.includes(".")) value = `${value}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) {
    throw new Error("SHOPIFY_SHOP must be a valid myshopify.com domain or store handle");
  }
  return value;
}
