const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { registerApiRoutes } = require("../routes/apiRoutes");

test("generated files route handles missing normalize helper dependency", async () => {
  const app = express();
  const server = http.createServer(app);

  registerApiRoutes(app, {
    path: require("path"),
    fs: require("fs"),
    cacheDir: "/tmp/cache",
    generatedDir: "/tmp/generated",
    readCache: () => null,
    writeCache: () => null,
    readProductCache: () => null,
    writeProductCache: () => null,
    readFullDetailsCache: () => null,
    fullDetailsCacheFilePath: () => "/tmp/full-details.json",
    productCacheFilePath: () => "/tmp/products.json",
    generatedCatalogDirPath: () => "/tmp/generated/catalog",
    isCacheFresh: () => false,
    fetchCatalogsFromApi: async () => [],
    fetchProductsByCatalogVersionId: async () => ({}),
    extractItemsFromPayload: () => ({ items: [], path: "items" }),
    ensureFullDetailsCache: async () => ({
      status: "ready",
      cachePayload: null,
    }),
    getFullDetailsJobStatus: () => null,
    buildFullDetailsPreview: () => [],
    buildFullDetailsMetadata: () => ({ total: 0 }),
    buildFullDetailsJobMetadata: () => ({ total: 0 }),
    getCatalogNameByVersionId: () => "Test Catalog",
    buildFileMetadata: () => null,
    listJsonFiles: () => [],
    sanitizeFileSegment: (value) => String(value || "unknown"),
    findCatalogBySiteCode: () => null,
    isPathInside: () => true,
    writeZipFileToResponse: () => {},
    getCatalogItemsFromCache: () => [],
    findCatalogByVersionId: () => null,
    deleteProductCache: () => false,
    deleteFullDetailsCache: () => false,
    deleteItemDetailsCache: () => false,
    clearFullDetailsJobStatus: () => {},
    productTypeExportJobs: new Map(),
    getProductTypeExportJobKey: () => "job",
    unregisterActiveJob: () => {},
    getFullDetailsJobKey: () => "job",
    catalogDependencyCacheFilePath: () => "/tmp/deps.json",
    deleteDirectoryIfExists: () => false,
    itemDetailsMemoCache: new Map(),
    itemDetailsRequestQueue: new Map(),
    getProductTypeExportJobStatus: () => null,
    buildProductTypeExports: () => ({ totalFiles: 0, totalProducts: 0 }),
    buildProductTypeExportResponse: () => ({ status: "ready" }),
    setProductTypeExportJobStatus: () => {},
    getGeneratedCatalogName: () => "Test Catalog",
    readGeneratedProductTypeFiles: () => ({ types: [], availableTypes: [] }),
    readJsonFile: () => null,
    startProductTypeExportJob: () => ({ job: null }),
    normalizeLegacyGeneratedProductTypeFiles: () => [],
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/catalog-products/generated-files?catalogVersionId=123`,
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({ statusCode: res.statusCode, body: data }),
          );
        },
      );
      req.on("error", reject);
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /"catalogVersionId":"123"/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
