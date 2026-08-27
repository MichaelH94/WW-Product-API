import {normalizeShopDomain} from "../shared/shopify/domain.ts";

export interface WorkerEnvironment {
  SHOPIFY_SHOP: string;
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
  INTERNAL_API_KEY: string;
}

export interface WorkerConfig {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  internalApiKey: string;
}

function required(
  environment: Partial<WorkerEnvironment>,
  name: keyof WorkerEnvironment,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required Worker binding: ${name}`);
  return value;
}

export function loadWorkerConfig(
  environment: Partial<WorkerEnvironment>,
): WorkerConfig {
  const internalApiKey = required(environment, "INTERNAL_API_KEY");
  if (internalApiKey.length < 32) {
    throw new Error("INTERNAL_API_KEY must contain at least 32 characters");
  }

  return {
    shopDomain: normalizeShopDomain(required(environment, "SHOPIFY_SHOP")),
    clientId: required(environment, "SHOPIFY_CLIENT_ID"),
    clientSecret: required(environment, "SHOPIFY_CLIENT_SECRET"),
    internalApiKey,
  };
}
