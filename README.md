# WW Product API

WW Product API is a private, read-only service that gives authorized tools access to Shopify product, variant, and inventory data. It is designed for use by a Custom GPT and other trusted internal clients.

## Architecture

```text
Custom GPT or trusted client
  -> Bearer-authenticated HTTPS API
  -> Cloudflare Worker
  -> Shopify Admin GraphQL API
```

The Worker obtains Shopify access tokens server-side through the client credentials grant. Shopify credentials and access tokens are never sent to API clients. The service exposes only `GET` routes and contains no Shopify mutations.

## Supported operations

- Search products by text, vendor, or product type.
- Find variants by exact SKU or barcode with inventory returned immediately.
- Retrieve product and variant details.
- Retrieve tracked inventory quantities by location.
- Check service health and the configured Shopify API version.

The Custom GPT contract is defined in [`docs/openapi.yaml`](docs/openapi.yaml). Detailed response and pagination guidance is available in [`docs/api.md`](docs/api.md).

## Required configuration

Configure these values as server-side environment variables or Cloudflare Worker secrets:

- `SHOPIFY_SHOP`: Shopify store hostname, such as `store.myshopify.com`.
- `SHOPIFY_CLIENT_ID`: Shopify app client ID.
- `SHOPIFY_CLIENT_SECRET`: Shopify app client secret.
- `INTERNAL_API_KEY`: Random bearer key of at least 32 characters for API clients.

Never place these values in source code, browser code, the OpenAPI document, or committed environment files. Use [`.dev.vars.example`](.dev.vars.example) and [`.env.example`](.env.example) only as placeholder templates.

The Shopify app must remain read-only. Its product and inventory access uses `read_products`, `read_inventory`, and `read_locations`; no `write_*` scope is permitted.

## Local Worker development

Requirements: Node.js, npm, a Shopify app configured for the target store, and a Cloudflare account for deployment.

1. Install dependencies:

   ```shell
   npm install
   ```

2. Copy `.dev.vars.example` to `.dev.vars` and replace its placeholders locally. Do not commit `.dev.vars`.

3. Start the Worker:

   ```shell
   npm run dev:worker
   ```

4. Call an endpoint with the configured API key:

   ```shell
   curl -H "Authorization: Bearer YOUR_INTERNAL_API_KEY" \
     "http://localhost:8787/api/products/search?q=snowboards"
   ```

## Validation

Run the complete automated test suite and builds before deployment:

```shell
npm test
npm run build
npm run build:api
npm run build:worker
```

Validate the OpenAPI document when it changes:

```shell
npx --yes @redocly/cli lint docs/openapi.yaml
```

## Deployment

Provision the four required values as Cloudflare Worker secrets, then deploy:

```shell
npm run deploy:worker
```

Wrangler configuration is stored in [`wrangler.jsonc`](wrangler.jsonc). It contains binding names only and must never contain credential values. See [`docs/cloudflare-worker.md`](docs/cloudflare-worker.md) for production setup and secret-management instructions.

## Security expectations

- Send `Authorization: Bearer <INTERNAL_API_KEY>` with every API request.
- Keep Shopify permissions strictly read-only.
- Do not add mutation operations or write-capable HTTP routes.
- Keep broad searches lightweight; request detailed inventory only after identifying a product or variant.
- Treat response request IDs as diagnostic correlation values, not credentials.
