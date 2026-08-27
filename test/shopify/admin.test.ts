import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_GRAPHQL_ENDPOINT,
  ShopifyAdminApiError,
  ShopifyAdminGraphqlError,
  ShopifyAdminHttpError,
  ShopifyAdminResponseError,
  createAdminGraphqlExecutor,
} from "../../shared/shopify/admin.ts";

test("uses the authenticated Shopify Admin transport and returns data", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const execute = createAdminGraphqlExecutor(async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return Response.json({ data: { shop: { name: "Test Shop" } } });
  });

  const result = await execute<{ shop: { name: string } }>(
    "query ShopName { shop { name } }",
    { example: true },
  );

  assert.deepEqual(result, { shop: { name: "Test Shop" } });
  assert.equal(requestUrl, ADMIN_GRAPHQL_ENDPOINT);
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    query: "query ShopName { shop { name } }",
    variables: { example: true },
  });
  assert.equal((requestInit?.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("surfaces HTTP failures", async () => {
  const execute = createAdminGraphqlExecutor(async () =>
    Response.json({ error: "denied" }, { status: 403, statusText: "Forbidden" }));

  await assert.rejects(
    () => execute("query Test { shop { id } }"),
    (error: unknown) =>
      error instanceof ShopifyAdminHttpError && error.status === 403,
  );
});

test("preserves HTTP throttle status even when the body is not JSON", async () => {
  const execute = createAdminGraphqlExecutor(async () =>
    new Response("throttled", {
      status: 429,
      statusText: "Too Many Requests",
      headers: {"Retry-After": "2"},
    }));

  await assert.rejects(
    () => execute("query Test { shop { id } }"),
    (error: unknown) =>
      error instanceof ShopifyAdminHttpError &&
      error.status === 429 &&
      error.retryAfter === "2",
  );
});

test("surfaces top-level GraphQL errors", async () => {
  const execute = createAdminGraphqlExecutor(async () => Response.json({
    data: null,
    errors: [{ message: "Access denied", path: ["products"] }],
  }));

  await assert.rejects(
    () => execute("query Test { products(first: 1) { nodes { id } } }"),
    (error: unknown) =>
      error instanceof ShopifyAdminGraphqlError &&
      error.errors[0]?.message === "Access denied",
  );
});

test("rejects invalid JSON and missing data envelopes", async () => {
  const invalidJson = createAdminGraphqlExecutor(async () =>
    new Response("not-json", { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(
    () => invalidJson("query Test { shop { id } }"),
    ShopifyAdminResponseError,
  );

  const missingData = createAdminGraphqlExecutor(async () => Response.json({}));
  await assert.rejects(
    () => missingData("query Test { shop { id } }"),
    ShopifyAdminResponseError,
  );
});

test("wraps transport failures without exposing credentials", async () => {
  const execute = createAdminGraphqlExecutor(async () => {
    throw new Error("offline");
  });

  await assert.rejects(
    () => execute("query Test { shop { id } }"),
    ShopifyAdminApiError,
  );
});
