# Cloudflare Worker deployment

The Worker hosts only the bearer-authenticated, read-only HTTP API documented
in `docs/openapi.yaml`. Shopify App Home, extensions, OAuth callbacks, local
Node listeners, and development diagnostics are not included in its bundle.

## Runtime configuration

The Worker requires four encrypted Cloudflare secrets:

- `SHOPIFY_SHOP`: the store's permanent `*.myshopify.com` domain
- `SHOPIFY_CLIENT_ID`: the Dev Dashboard app client ID
- `SHOPIFY_CLIENT_SECRET`: the Dev Dashboard app client secret
- `INTERNAL_API_KEY`: a unique random value of at least 32 characters

The app and store must belong to the same Shopify organization, and the app
must be installed on the store. Its released app version must contain only the
read scopes needed by this service. The current local configuration contains no
Shopify write scopes.

Do not configure a static Shopify Admin API access token. The Worker exchanges
the client ID and secret for a short-lived token, keeps it only in isolate
memory, refreshes it before expiry, and retries once with a fresh token after a
Shopify `401` response.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Replace every placeholder with development credentials. `.dev.vars` is
   ignored by Git.
3. Run `npm run dev:worker`.
4. Call the local URL with `Authorization: Bearer <INTERNAL_API_KEY>`.

Wrangler uses the production Worker runtime locally. The existing Node API can
still be run independently with `npm run dev:api` when needed.

## Verification

Run these commands before uploading a Worker version:

```text
npm test
npm run build:worker
```

The Worker build is a dry run and does not deploy.

## Production secrets

Configure each secret without placing its value in a command, tracked file, or
shell history:

```text
npx wrangler secret put SHOPIFY_SHOP
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
npx wrangler secret put INTERNAL_API_KEY
```

Cloudflare secret updates create a Worker version. Coordinate secret setup with
the intended release process and confirm the version before routing production
traffic.

## Deployment

1. Verify that Shopify Admin API `2026-07` remains the selected stable version.
2. Confirm the installed app grants only the required read scopes.
3. Run the verification commands above.
4. Run `npm run deploy:worker` only when deployment is explicitly approved.
5. Configure a dedicated HTTPS hostname for the Worker.
6. Replace the placeholder server host in `docs/openapi.yaml` before importing
   that document into the Custom GPT action.

The Custom GPT stores only `INTERNAL_API_KEY`. It never receives the Shopify
client secret, client ID, or generated Shopify access token.
