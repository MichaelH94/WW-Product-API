# Read-only product API

This internal JSON API exposes read-only product information from one Shopify
store. Every route requires an internal bearer key and supports `GET` only.

## Configuration

Set these server-side environment variables. Never place them in browser code
or commit them to the repository.

- `SHOPIFY_SHOP`: Store handle or `store.myshopify.com` domain.
- `SHOPIFY_CLIENT_ID` or Shopify CLI's `SHOPIFY_API_KEY`.
- `SHOPIFY_CLIENT_SECRET` or Shopify CLI's `SHOPIFY_API_SECRET`.
- `INTERNAL_API_KEY`: Random bearer key containing at least 32 characters.
- `PORT`: Optional; defaults to `3000`.

Shopify CLI supplies the client ID, client secret, and port during `shopify app
dev`. Set `SHOPIFY_SHOP` and `INTERNAL_API_KEY` locally, then run `npm run dev`.
For direct local execution, run `npm run dev:api`.

Copy `.env.example` to `.env` for local development and replace every
placeholder. `.env` and other environment-specific files are ignored by Git;
only the placeholder example is tracked.

## Authentication and responses

Send `Authorization: Bearer <INTERNAL_API_KEY>` with every request. Responses
are JSON with `Cache-Control: no-store` and a request ID:

```json
{"data": {}, "meta": {"requestId": "uuid"}}
```

Errors have a stable shape and never include Shopify credentials or sessions:

```json
{
  "error": {"code": "INVALID_INPUT", "message": "limit must be between 1 and 50"},
  "meta": {"requestId": "uuid"}
}
```

## Endpoints

### `GET /api/health`

Returns service status and the configured Shopify Admin API version.

### `GET /api/products/search`

Parameters: `q`, `vendor`, `productType`, `limit`, and `after`. At least one
search filter is required. `limit` defaults to 10 and has a maximum of 50.
Pass the opaque `pageInfo.endCursor` returned by Shopify as `after` to request
the next page; malformed and duplicate cursors are rejected.

Example: `/api/products/search?q=blue%20shirt&vendor=Acme&limit=10`

### `GET /api/products/by-sku/:sku`

Returns every matching variant and its parent product because SKUs aren't
guaranteed to be unique.

### `GET /api/products/by-barcode/:barcode`

Returns every matching variant and its parent product because barcodes aren't
guaranteed to be unique.

### `GET /api/products/:id`

Accepts a numeric product ID or URL-encoded Shopify Product GID. Returns 404
when the product doesn't exist.

### `GET /api/variants/:id/inventory`

Accepts a numeric variant ID or URL-encoded Shopify ProductVariant GID. Returns
inventory tracking status and exact `available`, `on_hand`, and `incoming`
quantities grouped by location. Locations include active status and staff-useful
address fields. Use `limit` (default 20, maximum 50) and pass an unchanged
`inventoryItem.pageInfo.endCursor` as `after` to retrieve additional locations.
The response includes one of `found_with_inventory`, `found_zero_inventory`,
`inventory_not_tracked`, or `no_inventory_levels`. Missing products and
exhausted transient upstream failures use `product_not_found` and
`temporary_upstream_failure` in sanitized error details.

Shopify's 2026-07 schema requires `read_products`, `read_inventory`, and
`read_locations` for product inventory. Selecting any `Location.address` field
also requires the read-only `read_markets_home` scope. No write scope is used.

Broad search and exact SKU/barcode lookup return lightweight inventory-item
identifiers only. Use this endpoint after identifying the variant when complete
inventory-by-location data is needed.

No mutation or product write routes exist. POST, PUT, PATCH, and DELETE return
`405 METHOD_NOT_ALLOWED`.

Shopify token requests time out after 10 seconds and Admin GraphQL requests
after 15 seconds. Upstream timeouts return `504 SHOPIFY_TIMEOUT`. Shopify
throttling returns `503 SHOPIFY_THROTTLED` with `Retry-After`; callers should
wait before retrying. Safe read requests retry transient network, HTTP, and
Shopify GraphQL failures up to three total attempts using jittered exponential
backoff. Diagnostic details contain only safe status, retryability, result
state, and this API's request ID; Shopify request IDs stay in internal logs.
