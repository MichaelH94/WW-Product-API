import {normalizeShopDomain} from "../shared/shopify/domain.ts";

export {normalizeShopDomain} from "../shared/shopify/domain.ts";

export interface ApiConfig {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  internalApiKey: string;
  port: number;
  graphqlCostDebug: boolean;
}

function required(environment: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const internalApiKey = required(environment, ["INTERNAL_API_KEY"]);
  if (internalApiKey.length < 32) {
    throw new Error("INTERNAL_API_KEY must contain at least 32 characters");
  }

  const portValue = environment.PORT ?? environment.SERVER_PORT ?? "3000";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    shopDomain: normalizeShopDomain(required(environment, [
      "SHOPIFY_SHOP",
      "SHOPIFY_STORE_DOMAIN",
    ])),
    clientId: required(environment, ["SHOPIFY_CLIENT_ID", "SHOPIFY_API_KEY"]),
    clientSecret: required(environment, ["SHOPIFY_CLIENT_SECRET", "SHOPIFY_API_SECRET"]),
    internalApiKey,
    port,
    graphqlCostDebug: environment.SHOPIFY_GRAPHQL_COST_DEBUG === "1",
  };
}
