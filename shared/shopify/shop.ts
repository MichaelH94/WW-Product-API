import {
  ShopifyAdminResponseError,
  type AdminGraphqlExecutor,
} from "./admin.ts";

export const IS_PARTNER_DEVELOPMENT_STORE_QUERY = `query IsPartnerDevelopmentStore {
  shop {
    plan {
      partnerDevelopment
    }
  }
}`;

export async function isPartnerDevelopmentStore(
  executor: AdminGraphqlExecutor,
): Promise<boolean> {
  const data = await executor<unknown>(IS_PARTNER_DEVELOPMENT_STORE_QUERY);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ShopifyAdminResponseError("Invalid Shopify shop response");
  }

  const shop = (data as Record<string, unknown>).shop;
  if (typeof shop !== "object" || shop === null || Array.isArray(shop)) {
    throw new ShopifyAdminResponseError("Invalid Shopify shop data");
  }

  const plan = (shop as Record<string, unknown>).plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new ShopifyAdminResponseError("Invalid Shopify shop plan data");
  }

  const partnerDevelopment = (plan as Record<string, unknown>).partnerDevelopment;
  if (typeof partnerDevelopment !== "boolean") {
    throw new ShopifyAdminResponseError(
      "Invalid Shopify shop development-store indicator",
    );
  }

  return partnerDevelopment;
}
