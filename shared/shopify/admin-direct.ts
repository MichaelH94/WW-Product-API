import {
  ADMIN_API_VERSION,
  createAdminGraphqlExecutor,
} from "./admin.ts";

export const ADMIN_GRAPHQL_ENDPOINT =
  `shopify:admin/api/${ADMIN_API_VERSION}/graphql.json`;

export const executeAdminGraphql = createAdminGraphqlExecutor(
  globalThis.fetch.bind(globalThis),
  ADMIN_GRAPHQL_ENDPOINT,
);
