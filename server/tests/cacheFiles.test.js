const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCacheFileHelpers } = require("../helpers/cacheFiles");

test("cache helpers expose read/write functions for catalog and product caches", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cic-cache-"));
  const cacheDir = path.join(tempRoot, "cache");
  const generatedDir = path.join(tempRoot, "generated");
  const helpers = createCacheFileHelpers({
    cacheDir,
    generatedDir,
    oneDayMs: 86400000,
  });

  assert.equal(typeof helpers.readCache, "function");
  assert.equal(typeof helpers.writeCache, "function");
  assert.equal(typeof helpers.readProductCache, "function");
  assert.equal(typeof helpers.writeProductCache, "function");
  assert.equal(typeof helpers.readCatalogDependencyCache, "function");
  assert.equal(typeof helpers.writeCatalogDependencyCache, "function");
  assert.equal(typeof helpers.readCatalogDependencyCache, "function");
  assert.equal(typeof helpers.writeCatalogDependencyCache, "function");

  const writtenCatalog = helpers.writeCache("en-US", [{ id: 1, name: "Test" }]);
  const readCatalog = helpers.readCache("en-US");
  assert.deepEqual(readCatalog.items, writtenCatalog.items);

  const writtenProducts = helpers.writeProductCache("en-US", "19947", {
    items: [{ id: 2, name: "Product" }],
  });
  const readProducts = helpers.readProductCache("en-US", "19947");
  assert.deepEqual(readProducts.items, writtenProducts.items);

  const writtenDependencies = helpers.writeCatalogDependencyCache(
    "site-code",
    { dependencies: [{ catalogVersionId: "123" }] },
    "Test Catalog",
  );
  const readDependencies = helpers.readCatalogDependencyCache(
    "site-code",
    "Test Catalog",
  );
  assert.deepEqual(readDependencies, writtenDependencies);
});
