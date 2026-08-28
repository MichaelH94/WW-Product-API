import {
  ADMIN_API_VERSION,
  ShopifyAdminApiError,
  ShopifyAdminGraphqlError,
  ShopifyAdminHttpError,
  ShopifyAdminRetryExhaustedError,
  ShopifyAdminTimeoutError,
  type ShopifyRequestContext,
} from "../shared/shopify/admin.ts";
import type {
  ExactVariantLookupResult,
  InventoryForVariant,
  Product,
  ProductSearchResult,
} from "../shared/shopify/index.ts";

export interface ProductApiDataAccess {
  searchProducts(options: {
    q?: string;
    vendor?: string;
    productType?: string;
    after?: string;
    first: number;
  }, context?: ShopifyRequestContext): Promise<ProductSearchResult>;
  getProductBySku(
    sku: string,
    context?: ShopifyRequestContext,
  ): Promise<ExactVariantLookupResult>;
  getProductByBarcode(
    barcode: string,
    context?: ShopifyRequestContext,
  ): Promise<ExactVariantLookupResult>;
  getProductById(
    id: string,
    options?: {
      metafields?: ReadonlyArray<{namespace: string; key: string}>;
      mediaFirst?: number;
      mediaAfter?: string;
    },
    context?: ShopifyRequestContext,
  ): Promise<Product | null>;
  getInventoryForVariant(
    id: string,
    options: {first: number; after?: string},
    context?: ShopifyRequestContext,
  ): Promise<InventoryForVariant | null>;
}

class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(status: number, body: unknown, requestId: string, extraHeaders = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
      ...extraHeaders,
    },
  });
}

async function equalSecret(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const actualBytes = new Uint8Array(actualDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  const workerSubtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
  };

  if (typeof workerSubtle.timingSafeEqual === "function") {
    return workerSubtle.timingSafeEqual(actualBytes, expectedBytes);
  }

  // SHA-256 outputs are fixed length. This fallback keeps local Node tests
  // portable while production Workers use their native timing-safe primitive.
  let mismatch = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    mismatch |= actualBytes[index] ^ expectedBytes[index];
  }
  return mismatch === 0;
}

async function authenticate(request: Request, expectedKey: string): Promise<void> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match || !await equalSecret(match[1], expectedKey)) {
    throw new ApiRequestError(401, "UNAUTHORIZED", "A valid bearer token is required");
  }
}

function text(value: string | null, name: string, maximum = 200): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new ApiRequestError(400, "INVALID_INPUT", `${name} must not be empty`);
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ApiRequestError(
      400,
      "INVALID_INPUT",
      `${name} must be ${maximum} characters or fewer and contain no control characters`,
    );
  }
  return normalized;
}

function limit(value: string | null): number {
  if (value === null) return 10;
  if (!/^\d+$/.test(value)) {
    throw new ApiRequestError(400, "INVALID_INPUT", "limit must be an integer");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 50) {
    throw new ApiRequestError(400, "INVALID_INPUT", "limit must be between 1 and 50");
  }
  return parsed;
}

function inventoryLimit(value: string | null): number {
  if (value === null) return 20;
  if (!/^\d+$/.test(value)) {
    throw new ApiRequestError(400, "INVALID_INPUT", "limit must be an integer");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 50) {
    throw new ApiRequestError(400, "INVALID_INPUT", "limit must be between 1 and 50");
  }
  return parsed;
}

function imageLimit(value: string | null): number {
  if (value === null) return 10;
  if (!/^\d+$/.test(value)) {
    throw new ApiRequestError(400, "INVALID_INPUT", "imageLimit must be an integer");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 10) {
    throw new ApiRequestError(400, "INVALID_INPUT", "imageLimit must be between 1 and 10");
  }
  return parsed;
}

function cursor(value: string | null, name = "after"): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 1024 ||
    !/^[A-Za-z0-9+/_=-]+$/.test(normalized)
  ) {
    throw new ApiRequestError(
      400,
      "INVALID_INPUT",
      `${name} must be a valid Shopify pagination cursor of 1024 characters or fewer`,
    );
  }
  return normalized;
}

function assertQueryParameters(url: URL, allowed: ReadonlySet<string>): void {
  const unknown = [...url.searchParams.keys()].filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ApiRequestError(400, "INVALID_INPUT", "Unknown query parameter", {
      parameters: [...new Set(unknown)].sort(),
    });
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new ApiRequestError(400, "INVALID_INPUT", `${key} must be supplied once`);
    }
  }
}

function pathValue(encoded: string, name: string, maximum = 200): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new ApiRequestError(400, "INVALID_INPUT", `${name} is not valid URL encoding`);
  }
  return text(decoded, name, maximum)!;
}

function success(data: unknown, requestId: string): Response {
  return json(200, {data, meta: {requestId}}, requestId);
}

function isExternalApiPath(pathname: string): boolean {
  return pathname === "/api/health" ||
    pathname === "/api/products" ||
    pathname.startsWith("/api/products/") ||
    pathname.startsWith("/api/variants/");
}

function safeRetryAfter(value: string | null): string {
  return value !== null && /^\d+(?:\.\d+)?$/.test(value) ? value : "1";
}

function graphqlDiagnosticDetails(error: ShopifyAdminGraphqlError): Record<string, unknown> {
  const shopifyCodes = [...new Set(error.errors.flatMap(({extensions}) => {
    const code = extensions?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? [code] : [];
  }))];
  return {
    retryable: shopifyCodes.includes("THROTTLED") ||
      shopifyCodes.includes("INTERNAL_SERVER_ERROR"),
  };
}

export async function handleApiRequest(
  request: Request,
  options: {dataAccess: ProductApiDataAccess; internalApiKey: string},
): Promise<Response> {
  const requestId = crypto.randomUUID();

  try {
    const url = new URL(request.url);
    const requestContext: ShopifyRequestContext = {
      requestId,
      route: url.pathname,
    };

    // Shopify authentication callbacks are deliberately outside this API-key
    // boundary. Only the documented external product API is protected here.
    if (!isExternalApiPath(url.pathname)) {
      throw new ApiRequestError(404, "NOT_FOUND", "API route not found");
    }

    await authenticate(request, options.internalApiKey);

    if (request.method !== "GET") {
      throw new ApiRequestError(405, "METHOD_NOT_ALLOWED", "Only GET is supported");
    }

    if (url.pathname === "/api/health") {
      assertQueryParameters(url, new Set());
      return success({status: "ok", adminApiVersion: ADMIN_API_VERSION}, requestId);
    }

    if (url.pathname === "/api/products/search") {
      const allowed = new Set(["q", "vendor", "productType", "limit", "after"]);
      assertQueryParameters(url, allowed);
      const q = text(url.searchParams.get("q"), "q");
      const vendor = text(url.searchParams.get("vendor"), "vendor");
      const productType = text(url.searchParams.get("productType"), "productType");
      const after = cursor(url.searchParams.get("after"));
      if (q === undefined && vendor === undefined && productType === undefined) {
        throw new ApiRequestError(
          400,
          "INVALID_INPUT",
          "At least one of q, vendor, or productType is required",
        );
      }
      const result = await options.dataAccess.searchProducts({
        ...(q === undefined ? {} : {q}),
        ...(vendor === undefined ? {} : {vendor}),
        ...(productType === undefined ? {} : {productType}),
        ...(after === undefined ? {} : {after}),
        first: limit(url.searchParams.get("limit")),
      }, requestContext);
      return success(result, requestId);
    }

    const skuMatch = /^\/api\/products\/by-sku\/([^/]+)$/.exec(url.pathname);
    if (skuMatch) {
      assertQueryParameters(url, new Set());
      return success(
        await options.dataAccess.getProductBySku(
          pathValue(skuMatch[1], "sku", 100),
          requestContext,
        ),
        requestId,
      );
    }

    const barcodeMatch = /^\/api\/products\/by-barcode\/([^/]+)$/.exec(url.pathname);
    if (barcodeMatch) {
      assertQueryParameters(url, new Set());
      return success(
        await options.dataAccess.getProductByBarcode(
          pathValue(barcodeMatch[1], "barcode", 100),
          requestContext,
        ),
        requestId,
      );
    }

    const productMatch = /^\/api\/products\/([^/]+)$/.exec(url.pathname);
    if (productMatch) {
      const allowed = new Set(["imageLimit", "imageAfter"]);
      assertQueryParameters(url, allowed);
      const imageAfter = cursor(url.searchParams.get("imageAfter"), "imageAfter");
      const product = await options.dataAccess.getProductById(
        pathValue(productMatch[1], "id", 100),
        {
          mediaFirst: imageLimit(url.searchParams.get("imageLimit")),
          ...(imageAfter === undefined ? {} : {mediaAfter: imageAfter}),
        },
        requestContext,
      );
      if (!product) {
        throw new ApiRequestError(404, "NOT_FOUND", "Product not found", {
          state: "product_not_found",
        });
      }
      return success(product, requestId);
    }

    const inventoryMatch = /^\/api\/variants\/([^/]+)\/inventory$/.exec(
      url.pathname,
    );
    if (inventoryMatch) {
      const allowed = new Set(["limit", "after"]);
      assertQueryParameters(url, allowed);
      const after = cursor(url.searchParams.get("after"));
      const inventory = await options.dataAccess.getInventoryForVariant(
        pathValue(inventoryMatch[1], "id", 100),
        {
          first: inventoryLimit(url.searchParams.get("limit")),
          ...(after === undefined ? {} : {after}),
        },
        requestContext,
      );
      if (!inventory) {
        throw new ApiRequestError(404, "NOT_FOUND", "Product variant not found", {
          state: "product_not_found",
        });
      }
      return success(inventory, requestId);
    }

    throw new ApiRequestError(404, "NOT_FOUND", "API route not found");
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return json(
        error.status,
        {
          error: {code: error.code, message: error.message, ...(error.details ? {details: error.details} : {})},
          meta: {requestId},
        },
        requestId,
        error.status === 405
          ? {Allow: "GET"}
          : error.status === 401
          ? {"WWW-Authenticate": "Bearer"}
          : {},
      );
    }
    if (error instanceof ShopifyAdminRetryExhaustedError) {
      return json(
        503,
        {
          error: {
            code: "TEMPORARY_UPSTREAM_FAILURE",
            message: "Shopify data is temporarily unavailable",
            details: {
              retryable: true,
              state: "temporary_upstream_failure",
            },
          },
          meta: {requestId},
        },
        requestId,
        {"Retry-After": "1"},
      );
    }
    if (error instanceof ShopifyAdminTimeoutError) {
      return json(
        504,
        {
          error: {
            code: "SHOPIFY_TIMEOUT",
            message: "Shopify did not respond before the upstream timeout",
            details: {retryable: true},
          },
          meta: {requestId},
        },
        requestId,
      );
    }

    const throttled = error instanceof ShopifyAdminHttpError && error.status === 429 ||
      error instanceof ShopifyAdminGraphqlError &&
        error.errors.some(({extensions}) => extensions?.code === "THROTTLED");
    if (throttled) {
      const retryAfter = error instanceof ShopifyAdminHttpError
        ? safeRetryAfter(error.retryAfter)
        : "1";
      return json(
        503,
        {
          error: {
            code: "SHOPIFY_THROTTLED",
            message: "Shopify is temporarily throttling requests",
            details: {
              retryable: true,
              ...(error instanceof ShopifyAdminHttpError
                ? {upstreamStatus: error.status}
                : graphqlDiagnosticDetails(error)),
            },
          },
          meta: {requestId},
        },
        requestId,
        {"Retry-After": retryAfter},
      );
    }

    const upstream = error instanceof ShopifyAdminApiError;
    const upstreamDetails = error instanceof ShopifyAdminHttpError
      ? {retryable: error.status >= 500, upstreamStatus: error.status}
      : error instanceof ShopifyAdminGraphqlError
      ? graphqlDiagnosticDetails(error)
      : {retryable: true};
    return json(
      upstream ? 502 : 500,
      {
        error: {
          code: upstream ? "SHOPIFY_UPSTREAM_ERROR" : "INTERNAL_ERROR",
          message: upstream
            ? "Shopify data could not be retrieved"
            : "An unexpected error occurred",
          ...(upstream ? {details: upstreamDetails} : {}),
        },
        meta: {requestId},
      },
      requestId,
    );
  }
}
