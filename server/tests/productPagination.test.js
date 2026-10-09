const test = require("node:test");
const assert = require("node:assert/strict");
const { createProductsFetcher } = require("../services/productPagination");

function response(payload, ok = true) {
  return {
    ok,
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  };
}

test("fetches every product page and merges decoded results", async () => {
  const urls = [];
  const pages = [
    { continuationToken: "next token/+", results: [{ id: 1 }, { id: 2 }] },
    { continuationToken: "last", results: [{ id: 3 }] },
    { continuationToken: "", results: [{ id: 4 }] },
  ];
  const fetchProducts = createProductsFetcher({
    fetchUrl: async (url) => {
      urls.push(url);
      return response(pages.shift());
    },
    decodeProductsResponse: (body) => Buffer.from(body).toString("utf8"),
  });

  const payload = await fetchProducts(19947);

  assert.deepEqual(payload.results, [
    { id: 1 },
    { id: 2 },
    { id: 3 },
    { id: 4 },
  ]);
  assert.equal(payload.continuationToken, "");
  assert.equal(urls.length, 3);
  assert.equal(new URL(urls[0]).searchParams.has("continuationToken"), false);
  assert.equal(
    new URL(urls[1]).searchParams.get("continuationToken"),
    "next token/+",
  );
  assert.equal(new URL(urls[2]).searchParams.get("continuationToken"), "last");
});

test("rejects a repeated continuation token", async () => {
  const pages = [
    { continuationToken: "same", results: [{ id: 1 }] },
    { continuationToken: "same", results: [{ id: 2 }] },
  ];
  const fetchProducts = createProductsFetcher({
    fetchUrl: async () => response(pages.shift()),
    decodeProductsResponse: (body) => Buffer.from(body).toString("utf8"),
  });

  await assert.rejects(() => fetchProducts("123"), /repeated continuationToken/);
});
