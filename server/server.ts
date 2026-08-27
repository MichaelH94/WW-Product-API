import {createProductDataAccess} from "../shared/shopify/products.ts";
import {loadApiConfig} from "./config.ts";
import {createApiHttpServer} from "./http.ts";
import {
  createClientCredentialsTokenProvider,
  createServerAdminGraphqlExecutor,
} from "./shopify.ts";

const config = loadApiConfig();
const getAccessToken = createClientCredentialsTokenProvider(config);
const executor = createServerAdminGraphqlExecutor({
  shopDomain: config.shopDomain,
  getAccessToken,
});
const dataAccess = createProductDataAccess(executor);

const server = createApiHttpServer({
  dataAccess,
  internalApiKey: config.internalApiKey,
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Read-only product API listening on port ${config.port}`);
});
