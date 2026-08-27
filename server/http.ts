import {createServer, type Server} from "node:http";

import {handleApiRequest, type ProductApiDataAccess} from "./api.ts";

export function createApiHttpServer(options: {
  dataAccess: ProductApiDataAccess;
  internalApiKey: string;
}): Server {
  return createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host ?? "127.0.0.1";
      const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
      });
      const response = await handleApiRequest(request, options);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      outgoing.end(JSON.stringify({
        error: {code: "INTERNAL_ERROR", message: "An unexpected error occurred"},
      }));
    }
  });
}
