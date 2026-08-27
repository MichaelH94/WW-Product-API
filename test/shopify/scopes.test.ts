import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("Shopify scopes include required inventory reads and reject all writes", async () => {
  const configuration = await readFile(
    new URL("../../shopify.app.toml", import.meta.url),
    "utf8",
  );
  const scopeLine = /^scopes\s*=\s*"([^"]*)"/m.exec(configuration);
  assert.ok(scopeLine, "shopify.app.toml must declare access scopes");
  const scopes = scopeLine[1].split(",").map((scope) => scope.trim());

  for (const required of [
    "read_products",
    "read_inventory",
    "read_locations",
    "read_markets_home",
  ]) {
    assert.ok(scopes.includes(required), `missing required scope ${required}`);
  }
  assert.deepEqual(
    scopes.filter((scope) => scope.startsWith("write_")),
    [],
    "write scopes are forbidden",
  );
});
