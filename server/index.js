const express = require("express");
const cors = require("cors");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const https = require("https");
const http = require("http");
const dotenv = require("dotenv");
const { registerApiRoutes } = require("./routes/apiRoutes");
const { createDailyRefreshScheduler } = require("./scheduler/dailyRefresh");
const { createCacheFileHelpers } = require("./helpers/cacheFiles");
const { getPool, initializeDatabase } = require("./db");
const { createAuthRepository } = require("./repositories/authRepository");
const {
  createCatalogSelectionRepository,
} = require("./repositories/catalogSelectionRepository");
const {
  createAuthMiddleware,
  registerAuthRoutes,
} = require("./routes/authRoutes");

dotenv.config({ path: path.resolve(__dirname, ".env") });

delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.ALL_PROXY;
delete process.env.all_proxy;

// OPTIMIZATION: HTTP/HTTPS agents with keep-alive and connection pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  freeSocketTimeout: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  freeSocketTimeout: 30000,
});

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://localhost:5100",
      "http://127.0.0.1:5100",
    ],
    credentials: true,
  }),
);

const PORT = process.env.PORT || 5100;
const cacheDir = path.join(__dirname, "catalogs");
const generatedDir = path.join(cacheDir, "generated");
const legacyCacheDir = path.join(__dirname, "cache");

function mergeDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entryName of fs.readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entryName);
    const targetPath = path.join(targetDir, entryName);
    const stat = fs.statSync(sourcePath);

    if (!fs.existsSync(targetPath)) {
      fs.renameSync(sourcePath, targetPath);
      continue;
    }

    if (stat.isDirectory()) {
      mergeDirectory(sourcePath, targetPath);
    }
  }
}

if (fs.existsSync(legacyCacheDir)) {
  if (!fs.existsSync(cacheDir)) {
    try {
      fs.renameSync(legacyCacheDir, cacheDir);
      console.log("Migrated legacy server/cache folder to server/catalogs.");
    } catch (error) {
      console.warn(
        "Unable to migrate legacy cache folder to catalogs. Please remove or rename server/cache manually.",
        error?.message || error,
      );
    }
  } else {
    try {
      mergeDirectory(legacyCacheDir, cacheDir);
      const remainingEntries = fs.readdirSync(legacyCacheDir);
      if (remainingEntries.length === 0) {
        fs.rmdirSync(legacyCacheDir);
        console.log(
          "Removed empty legacy server/cache folder after migration.",
        );
      } else {
        const backupCacheDir = path.join(__dirname, "cache.legacy");
        if (!fs.existsSync(backupCacheDir)) {
          fs.renameSync(legacyCacheDir, backupCacheDir);
          console.log(
            "Renamed leftover legacy cache folder to server/cache.legacy.",
          );
        }
      }
    } catch (error) {
      console.warn(
        "Unable to migrate legacy server/cache contents to server/catalogs.",
        error?.message || error,
      );
    }
  }
}

// OPTIMIZATION: Dynamic concurrency based on CPU cores (was hardcoded to 8)
const os = require("os");
const FULL_DETAILS_CONCURRENCY = Math.min(
  Math.max(os.cpus().length * 2, 16),
  32,
); // Scale with CPU cores: 16-32 workers
const FULL_DETAILS_PREVIEW_LIMIT = 1;
const FULL_DETAILS_LOG_LIMIT = 400;
const GZIP_GENERIC_HEADER = Uint8Array.from([
  0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 4, 10,
]);
const CYNCLY_MAGIC = "BTCA";
const CATALOG_DEPENDENCIES_CACHE_BASE_URL =
  "https://broadlume-x-catalog-api-stack-cic-import-bucket-prod-v1.s3.us-west-2.amazonaws.com/public/catalog-dependencies";
const fullDetailsJobs = new Map();
const productTypeExportJobs = new Map();
const MAX_ITEM_DETAILS_MEMO_ITEMS = 5000;

const itemDetailsMemoCache = new Map();
const itemDetailsRequestQueue = new Map();

const {
  cacheFilePath,
  productCacheFilePath,
  fullDetailsCacheFilePath,
  itemDetailsCacheFilePath,
  dailyRefreshSelectionFilePath,
  sanitizeFileSegment,
  generatedCatalogDirPath,
  readCache,
  writeCache,
  readProductCache,
  writeProductCache,
  catalogDependencyCacheFilePath,
  readCatalogDependencyCache,
  writeCatalogDependencyCache,
  isLockedFileError,
  deleteFileIfExists,
  deleteFullDetailsCache,
  deleteItemDetailsCache,
  deleteProductCache,
  deleteDirectoryIfExists,
  isPathInside,
  readJsonFile,
  writeJsonFile,
  listJsonFiles,
  writeZipFileToResponse,
  buildFileMetadata,
  pruneStaleGeneratedProductTypeFiles,
  normalizeLegacyGeneratedProductTypeFiles,
  getGeneratedProductTypeFileName,
  getProductTypeFromGeneratedFileName,
  isGeneratedProductTypeFileName,
  pruneDailyRefreshCache,
  isCacheFresh,
} = createCacheFileHelpers({
  cacheDir,
  generatedDir,
  oneDayMs: 24 * 60 * 60 * 1000,
});

function normalizeAllExistingGeneratedFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const entryName of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entryName.name);
    if (entryName.isDirectory()) {
      normalizeLegacyGeneratedProductTypeFiles(entryPath);
    }
  }
}

normalizeAllExistingGeneratedFiles(generatedDir);

app.use((req, res, next) => {
  if (req.method !== "GET" || req.path !== "/api/daily-refresh/status") {
    console.log("incoming request", {
      method: req.method,
      url: req.url,
      contentType: req.headers["content-type"],
    });
  }
  next();
});
app.use(express.json());

const authRepository = createAuthRepository(getPool());
const catalogSelectionRepository = createCatalogSelectionRepository(getPool());
const { optionalAuth, requireAuth } = createAuthMiddleware(authRepository);
app.use(optionalAuth);

app.get("/api/health", async (_req, res, next) => {
  try {
    await getPool().query("SELECT 1");
    res.json({ status: "healthy", database: "connected" });
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  console.error("Express JSON parse error:", err?.message || err);
  next(err);
});

// No global auth enforcement. We expose a simple login endpoint only.

app.use((err, req, res, next) => {
  console.error("Express JSON parse error:", err?.message || err);
  next(err);
});

// No global auth enforcement. We expose a simple login endpoint only.

function rememberItemDetails(parentItemId, itemDetails) {
  if (!parentItemId) {
    return;
  }

  if (itemDetailsMemoCache.size >= MAX_ITEM_DETAILS_MEMO_ITEMS) {
    itemDetailsMemoCache.delete(itemDetailsMemoCache.keys().next().value);
  }

  itemDetailsMemoCache.set(parentItemId, itemDetails);
}

function buildCatalogDependenciesFromCatalog(catalog, catalogVersionId) {
  if (!catalog || !Array.isArray(catalog.catalogVersions)) {
    return null;
  }

  const catalogVersion = catalog.catalogVersions.find(
    (version) => String(version?.id) === String(catalogVersionId),
  );
  const catalogDependencies = catalogVersion?.catalogDependencies;

  if (!catalogDependencies || typeof catalogDependencies !== "object") {
    return null;
  }

  const dependencyEntries = Object.entries(catalogDependencies)
    .map(([dependencyKey, dependency]) => {
      if (!dependency || typeof dependency !== "object") {
        return null;
      }

      return {
        dependencyKey,
        manufacturerId: dependency.catalogCode || "",
        manufacturerName:
          dependency.manufacturerName ||
          dependency.manufacturer ||
          dependency.name ||
          dependencyKey,
        catalogId: getParentCatalogIdFromDependencyKey(dependencyKey),
        catalogRefCode: dependency.companyCode || "",
        catalogVersionId: dependency.catalogVersionId || "",
        ...dependency,
      };
    })
    .filter(Boolean);

  return {
    retailerId: catalog.code || "",
    catalogId: catalog.id || "",
    catalogVersionId,
    dependencies: dependencyEntries,
    ...catalogDependencies,
  };
}

async function fetchCatalogDependencies(
  retailerCode,
  catalogName,
  fallbackDependencies = null,
) {
  const normalizedCode = String(retailerCode || "").trim();
  if (!normalizedCode) {
    throw new Error(
      "Failed to fetch catalog dependencies: retailer code is missing.",
    );
  }

  const cached = readCatalogDependencyCache(normalizedCode, catalogName);
  if (isCacheFresh(cached)) {
    return cached.data || null;
  }

  const dependencyUrl = `${CATALOG_DEPENDENCIES_CACHE_BASE_URL}/${encodeURIComponent(
    normalizedCode,
  )}.json`;

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchUrl(dependencyUrl, {
        timeout: 15000,
        retries: 0,
      });

      if (!response.ok) {
        lastError = new Error(
          `catalog dependencies returned HTTP ${response.status}`,
        );
      } else {
        const body = await response.text();
        const parsed = JSON.parse(body);
        writeCatalogDependencyCache(normalizedCode, parsed, catalogName);
        return parsed;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt === 0) {
      console.warn(
        "Failed to fetch catalog dependencies; retrying once:",
        describeFetchError(lastError),
      );
      await delay(500);
    }
  }

  if (fallbackDependencies && typeof fallbackDependencies === "object") {
    console.warn(
      "Using catalog cache fallback for catalog dependencies:",
      describeFetchError(lastError),
    );
    writeCatalogDependencyCache(
      normalizedCode,
      fallbackDependencies,
      catalogName,
    );
    return fallbackDependencies;
  }

  throw new Error(
    `Failed to fetch catalog dependencies after 2 attempts for retailer code ${normalizedCode}: ${describeFetchError(lastError)}`,
  );
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}

function normalizeFullDetailsEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return entry;
  }

  const itemDetails =
    entry.itemDetails || entry.fullDetails?.itemDetails || null;
  const product = entry.product || entry.fullDetails?.product || null;
  const normalizedParentDependencyKey = getParentDependencyKey(
    product?.itemRef || entry?.itemRef || itemDetails?.itemRef,
  );

  if (!normalizedParentDependencyKey) {
    return entry;
  }

  if (!entry.fullDetails) {
    const {
      itemDetails: _itemDetails,
      product: _product,
      ...restEntry
    } = entry;
    return {
      ...(product && typeof product === "object" ? product : {}),
      ...(itemDetails && typeof itemDetails === "object" ? itemDetails : {}),
      ...restEntry,
      enrichment: {
        ...(entry.enrichment || {}),
        parentDependencyKey: normalizedParentDependencyKey,
      },
    };
  }

  return {
    ...(product && typeof product === "object" ? product : {}),
    ...(itemDetails && typeof itemDetails === "object" ? itemDetails : {}),
    enrichment: {
      ...(entry.enrichment || {}),
      ...(entry.fullDetails.enrichment || {}),
      parentDependencyKey: normalizedParentDependencyKey,
    },
  };
}

function normalizeFullDetailsCachePayload(cachePayload) {
  if (!cachePayload || !Array.isArray(cachePayload.fullDetails)) {
    return cachePayload;
  }

  return {
    ...cachePayload,
    fullDetails: cachePayload.fullDetails.map(normalizeFullDetailsEntry),
  };
}

function readFullDetailsCache(lang, catalogVersionId) {
  const separateCache = readJsonFile(
    fullDetailsCacheFilePath(lang, catalogVersionId),
  );
  if (separateCache) {
    return normalizeFullDetailsCachePayload(separateCache);
  }

  const legacyProductCache = readProductCache(lang, catalogVersionId);
  if (legacyProductCache && Array.isArray(legacyProductCache.fullDetails)) {
    return normalizeFullDetailsCachePayload({
      lang,
      catalogVersionId,
      updatedAt: legacyProductCache.updatedAt,
      fullDetails: legacyProductCache.fullDetails,
      metadata: legacyProductCache.metadata || {},
    });
  }

  return null;
}

function countFullDetailsCacheEntries(lang, catalogVersionId) {
  const filePath = fullDetailsCacheFilePath(lang, catalogVersionId);
  const rawPayload = readJsonFile(filePath);

  if (!rawPayload || typeof rawPayload !== "object") {
    return 0;
  }

  if (Array.isArray(rawPayload.fullDetails)) {
    return rawPayload.fullDetails.length;
  }

  return 0;
}

function writeFullDetailsCache(lang, catalogVersionId, payload) {
  const filePath = fullDetailsCacheFilePath(lang, catalogVersionId);
  const cachePayload = {
    lang,
    catalogVersionId,
    updatedAt: new Date().toISOString(),
    ...payload,
  };
  writeJsonFile(filePath, cachePayload);
  return cachePayload;
}

function readItemDetailsCache(lang, catalogVersionId) {
  const cachePayload = readJsonFile(
    itemDetailsCacheFilePath(lang, catalogVersionId),
  );

  if (!cachePayload || typeof cachePayload !== "object") {
    return {
      lang,
      catalogVersionId,
      updatedAt: "",
      items: {},
      errors: {},
    };
  }

  return {
    lang,
    catalogVersionId,
    updatedAt: cachePayload.updatedAt || "",
    items:
      cachePayload.items && typeof cachePayload.items === "object"
        ? cachePayload.items
        : {},
    errors:
      cachePayload.errors && typeof cachePayload.errors === "object"
        ? cachePayload.errors
        : {},
  };
}

function writeItemDetailsCache(lang, catalogVersionId, cachePayload) {
  const payload = {
    lang,
    catalogVersionId,
    updatedAt: new Date().toISOString(),
    items:
      cachePayload?.items && typeof cachePayload.items === "object"
        ? cachePayload.items
        : {},
    errors:
      cachePayload?.errors && typeof cachePayload.errors === "object"
        ? cachePayload.errors
        : {},
  };
  writeJsonFile(itemDetailsCacheFilePath(lang, catalogVersionId), payload);
  return payload;
}

function seedItemDetailsCacheFromFullDetails(cachePayload, itemDetailsCache) {
  if (!cachePayload || !Array.isArray(cachePayload.fullDetails)) {
    return itemDetailsCache;
  }

  const items =
    itemDetailsCache?.items && typeof itemDetailsCache.items === "object"
      ? itemDetailsCache.items
      : {};
  const errors =
    itemDetailsCache?.errors && typeof itemDetailsCache.errors === "object"
      ? itemDetailsCache.errors
      : {};

  for (const entry of cachePayload.fullDetails) {
    const parentItemId = String(entry?.enrichment?.parentItemId || "").trim();
    if (!parentItemId || items[parentItemId]) {
      continue;
    }

    items[parentItemId] = entry;
    if (entry?.enrichment?.itemDetailsError) {
      errors[parentItemId] = entry.enrichment.itemDetailsError;
    }
  }

  return {
    ...(itemDetailsCache || {}),
    items,
    errors,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFetchError(error) {
  const cause = error?.cause;
  const causeCode = cause?.code ? ` (${cause.code})` : "";
  const causeMessage = cause?.message ? `: ${cause.message}` : "";
  return `${error?.message || "fetch failed"}${causeCode}${causeMessage}`;
}

// OPTIMIZATION: Helper function to fetch with native fetch and proper agents
async function fetchUrl(url, options = {}) {
  const timeout = options.timeout || 30000;
  const retries = Number.isInteger(options.retries) ? options.retries : 2;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions = {
        signal: controller.signal,
        headers: {
          Origin: "https://broadlume.com",
          ...(options.headers || {}),
        },
      };

      // Add agent for connection pooling (Node.js 18.0+)
      if (url.startsWith("https")) {
        fetchOptions.agent = httpsAgent;
      } else {
        fetchOptions.agent = httpAgent;
      }

      // Copy other options
      if (options.method) fetchOptions.method = options.method;
      if (options.body) fetchOptions.body = options.body;

      return await fetch(url, fetchOptions);
    } catch (error) {
      lastError = error;

      if (error.name === "AbortError" || attempt >= retries) {
        throw error;
      }

      await delay(250 * (attempt + 1));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error("fetch failed");
}

async function fetchCatalogsFromApi(lang) {
  const url = `https://api.cyncly-content.com/api/catalogs?lang=${encodeURIComponent(lang)}`;

  try {
    const response = await fetchUrl(url);
    const body = await response.text();

    if (!response.ok) {
      const parsed = JSON.parse(body);
      throw new Error(parsed.message || "Catalog API request failed.");
    }

    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : parsed.items || [];
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Catalog API request timeout.");
    }
    throw error;
  }
}

async function fetchProductsByCatalogVersionId(catalogVersionId) {
  const url = `https://management.cyncly-content.com/item-offering/api/v1/items?catalogVersionId=${encodeURIComponent(
    catalogVersionId,
  )}`;

  try {
    const response = await fetchUrl(url, { timeout: 30000 });
    const buffer = await response.arrayBuffer();
    const decoded = decodeProductsResponse(buffer);
    const parsed = JSON.parse(decoded);

    if (!response.ok) {
      throw new Error(parsed.message || "Products API request failed.");
    }

    return parsed;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Products API request timeout for catalogVersionId ${catalogVersionId}.`,
      );
    }

    throw new Error(
      `Products API request failed for catalogVersionId ${catalogVersionId}: ${describeFetchError(error)}`,
    );
  }
}

async function fetchItemDetails(parentItemId) {
  const url = `https://api.cyncly-content.com/api/v1/items/${encodeURIComponent(parentItemId)}`;

  try {
    const response = await fetchUrl(url, { timeout: 30000 });
    const buffer = await response.arrayBuffer();
    const decoded = decodeProductsResponse(buffer);
    const parsed = JSON.parse(decoded);

    if (!response.ok) {
      throw new Error(parsed.message || "Item details API request failed.");
    }

    return parsed;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Item details API request timeout.");
    }
    throw error;
  }
}

async function fetchGroupsByCatalogVersionId(catalogVersionId, lang = "en-US") {
  const url = `https://api.cyncly-content.com/api/v1/groups?catalogVersionId=${encodeURIComponent(
    catalogVersionId,
  )}&type=items&lang=${encodeURIComponent(lang)}`;

  try {
    const response = await fetchUrl(url, { timeout: 30000 });
    const buffer = await response.arrayBuffer();
    const decoded = decodeProductsResponse(buffer);
    const parsed = JSON.parse(decoded);

    if (!response.ok) {
      throw new Error(
        parsed.message ||
          `Groups API request failed with HTTP ${response.status}.`,
      );
    }

    return parsed;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Groups API request timeout for catalogVersionId ${catalogVersionId}.`,
      );
    }

    throw new Error(
      `Groups API request failed for catalogVersionId ${catalogVersionId}: ${describeFetchError(error)}`,
    );
  }
}

// OPTIMIZATION: Memoized version with deduplication queue
async function fetchItemDetailsMemoized(parentItemId) {
  if (!parentItemId) {
    return null;
  }

  if (itemDetailsMemoCache.has(parentItemId)) {
    return itemDetailsMemoCache.get(parentItemId);
  }

  if (itemDetailsRequestQueue.has(parentItemId)) {
    return itemDetailsRequestQueue.get(parentItemId);
  }

  const requestPromise = fetchItemDetails(parentItemId)
    .then((result) => {
      rememberItemDetails(parentItemId, result);
      itemDetailsRequestQueue.delete(parentItemId);
      return result;
    })
    .catch((error) => {
      itemDetailsRequestQueue.delete(parentItemId);
      throw error;
    });

  itemDetailsRequestQueue.set(parentItemId, requestPromise);
  return requestPromise;
}

setInterval(
  () => {
    itemDetailsMemoCache.clear();
    itemDetailsRequestQueue.clear();
  },
  60 * 60 * 1000,
);

function decodeProductsResponse(body) {
  const buffer = normalizeToUint8Array(body);
  const directText = uint8ArrayToString(buffer).trim();

  if (looksLikeJson(directText)) {
    return directText;
  }

  if (isCynclyCompressed(buffer)) {
    return decodeCynclyCompressedBuffer(buffer);
  }

  const base64Text = decodeBase64Payload(directText);
  if (base64Text) {
    return base64Text;
  }

  return directText;
}

function normalizeToUint8Array(body) {
  const typeName = Object.prototype.toString.call(body);

  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body);
  }

  if (
    body instanceof ArrayBuffer ||
    typeName === "[object ArrayBuffer]" ||
    typeName === "[object SharedArrayBuffer]"
  ) {
    return new Uint8Array(body);
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  if (body?.data !== undefined) {
    return normalizeToUint8Array(body.data);
  }

  if (body?.body !== undefined && body.body !== body) {
    return normalizeToUint8Array(body.body);
  }

  if (typeof body === "string") {
    return new Uint8Array(Buffer.from(body, "utf8"));
  }

  const constructorName = body?.constructor?.name;
  throw new Error(
    `Unsupported products API response type: ${constructorName || typeName}.`,
  );
}

function uint8ArrayToString(buffer) {
  return Buffer.from(buffer).toString("utf8");
}

function looksLikeJson(value) {
  return value.startsWith("{") || value.startsWith("[");
}

function isCynclyCompressed(buffer) {
  if (buffer.length < 10) {
    return false;
  }

  const magic = Array.from(buffer.slice(0, 4))
    .map((charCode) => String.fromCharCode(charCode))
    .join("");

  return magic === CYNCLY_MAGIC && buffer[4] === 1 && buffer[5] === 1;
}

function decodeCynclyCompressedBuffer(sourceBuffer) {
  const buffer = new Uint8Array(sourceBuffer);
  unseedBuffer(buffer);

  for (let index = 0; index < GZIP_GENERIC_HEADER.length; index += 1) {
    buffer[index] = GZIP_GENERIC_HEADER[index];
  }

  const uncompressed = zlib.gunzipSync(Buffer.from(buffer));
  return uncompressed.toString("utf8");
}

function unseedBuffer(buffer) {
  const byteAddrToXor = buffer.slice(6, 8);
  const seedBytes = buffer.slice(8, 10);
  const startIdx = byteAddrToXor[0];
  const endIdx = byteAddrToXor[1];

  for (let index = startIdx; index <= endIdx; index += 1) {
    buffer[index] = buffer[index] ^ seedBytes[index % seedBytes.length];
  }
}

function decodeBase64Payload(value) {
  const normalizedValue = value.replace(/\s+/g, "");

  if (
    !normalizedValue ||
    normalizedValue.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(normalizedValue)
  ) {
    return "";
  }

  const decodedBuffer = Buffer.from(normalizedValue, "base64");
  if (!decodedBuffer.length) {
    return "";
  }

  const decodedText = decodedBuffer.toString("utf8").trim();
  if (looksLikeJson(decodedText)) {
    return decodedText;
  }

  const decodedBytes = new Uint8Array(decodedBuffer);
  if (isCynclyCompressed(decodedBytes)) {
    return decodeCynclyCompressedBuffer(decodedBytes);
  }

  return "";
}

function extractItemsFromPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      items: payload,
      path: "root",
    };
  }

  const queue = [{ value: payload, path: "root" }];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    const { value, path } = current;

    if (!value || typeof value !== "object") {
      continue;
    }

    if (visited.has(value)) {
      continue;
    }

    visited.add(value);

    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;

      if (Array.isArray(child)) {
        return {
          items: child,
          path: childPath,
        };
      }

      if (child && typeof child === "object") {
        queue.push({
          value: child,
          path: childPath,
        });
      }
    }
  }

  return {
    items: [],
    path: "not-found",
  };
}

function extractGroupsFromPayload(payload) {
  const groups = [];
  const queue = [payload];
  const visited = new Set();

  while (queue.length) {
    const value = queue.shift();

    if (!value || typeof value !== "object" || visited.has(value)) {
      continue;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((item) => queue.push(item));
      continue;
    }

    const groupId = getGroupIdentifier(value);
    if (groupId) {
      groups.push(value);
    }

    Object.values(value).forEach((child) => {
      if (child && typeof child === "object") {
        queue.push(child);
      }
    });
  }

  return groups;
}

function getGroupIdentifier(group) {
  const candidates = [
    group?.id,
    group?.ref,
    group?.key,
    group?.groupRef,
    group?.groupId,
    group?.code,
  ];
  const value = candidates.find(
    (candidate) => candidate !== undefined && candidate !== null,
  );

  return value === undefined ? "" : String(value).trim();
}

function getGroupDisplayName(group) {
  const candidates = [
    group?.name,
    group?.displayName,
    group?.title,
    group?.label,
    group?.description,
  ];
  const value = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim(),
  );

  return value ? value.trim() : "";
}

function getGroupKind(group) {
  const values = [
    group?.type,
    group?.groupType,
    group?.category,
    group?.facetType,
    group?.kind,
    group?.role,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  if (values.includes("brand")) {
    return "brand";
  }

  if (values.includes("collection")) {
    return "collection";
  }

  return "";
}

function simplifyGroup(group) {
  if (!group || typeof group !== "object") {
    return null;
  }

  const id = getGroupIdentifier(group);
  const name = getGroupDisplayName(group);
  const type =
    getGroupKind(group) || String(group.type || group.groupType || "");

  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
  };
}

function buildGroupLookup(groupsPayload) {
  const groups = extractGroupsFromPayload(groupsPayload);
  const byRef = new Map();

  groups.forEach((group) => {
    const id = getGroupIdentifier(group);
    if (!id || byRef.has(id)) {
      return;
    }

    byRef.set(id, group);
  });

  return {
    groups,
    byRef,
  };
}

function getProductGroups(product, groupLookup) {
  const groupRefs = Array.isArray(product?.groupRefs) ? product.groupRefs : [];
  const matchedGroups = groupRefs
    .map((groupRef) => groupLookup?.byRef?.get(String(groupRef).trim()))
    .filter(Boolean);
  let brand = matchedGroups.find((group) => getGroupKind(group) === "brand");
  let collection = matchedGroups.find(
    (group) => getGroupKind(group) === "collection",
  );

  if ((!brand || !collection) && matchedGroups.length >= 2) {
    const unclassifiedGroups = matchedGroups.filter(
      (group) => !getGroupKind(group),
    );
    if (!collection && unclassifiedGroups[0]) {
      collection = unclassifiedGroups[0];
    }
    if (!brand && unclassifiedGroups[1]) {
      brand = unclassifiedGroups[1];
    }
  }

  return {
    brand: simplifyGroup(brand),
    collection: simplifyGroup(collection),
  };
}

function getCatalogItemsFromCache(lang = "en-US") {
  const cachePayload = readCache(lang);
  if (cachePayload && Array.isArray(cachePayload.items)) {
    return cachePayload.items;
  }

  return [];
}

function findCatalogBySiteCode(lang, siteCode) {
  const normalizedSiteCode = String(siteCode || "").trim();
  if (!normalizedSiteCode) {
    return null;
  }

  return (
    getCatalogItemsFromCache(lang).find(
      (catalog) => String(catalog?.code || "").trim() === normalizedSiteCode,
    ) || null
  );
}

function getLatestCatalogVersionIdByCatalogId(catalogs, catalogId) {
  const matchedCatalog = catalogs.find(
    (catalog) => String(catalog?.id) === String(catalogId),
  );

  if (!matchedCatalog || !Array.isArray(matchedCatalog.catalogVersions)) {
    return null;
  }

  const sortedVersionIds = matchedCatalog.catalogVersions
    .map((version) => version?.id)
    .filter((versionId) => versionId !== undefined && versionId !== null)
    .sort((left, right) => Number(right) - Number(left));

  return sortedVersionIds[0] || null;
}

function findCatalogByVersionId(catalogs, catalogVersionId) {
  if (!Array.isArray(catalogs)) {
    return null;
  }

  return (
    catalogs.find(
      (catalog) =>
        Array.isArray(catalog?.catalogVersions) &&
        catalog.catalogVersions.some(
          (version) => String(version?.id) === String(catalogVersionId),
        ),
    ) || null
  );
}

function getCatalogNameByVersionId(lang, catalogVersionId) {
  const catalogs = getCatalogItemsFromCache(lang);
  const matchedCatalog = findCatalogByVersionId(catalogs, catalogVersionId);
  return (
    matchedCatalog?.name ||
    matchedCatalog?.title ||
    `catalog-${catalogVersionId}`
  );
}

function getNestedValue(source, pathValue) {
  if (!source || !pathValue) {
    return undefined;
  }

  return String(pathValue)
    .split(".")
    .reduce(
      (current, key) => (current == null ? undefined : current[key]),
      source,
    );
}

function coerceExportValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "object") {
    return value;
  }

  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTitleCase(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function deriveProductNameFromCode(code, sku) {
  let name = String(code || "");
  const rawSku = String(sku || "").trim();
  const normalizedSku = String(sku || "").replace(/[-_\s]/g, "");

  if (!name) {
    return "";
  }

  if (rawSku) {
    name = name.replace(new RegExp(escapeRegExp(rawSku), "gi"), "");
  }

  if (normalizedSku) {
    name = name.replace(new RegExp(escapeRegExp(normalizedSku), "gi"), "");
  }

  name = name.replace(/-/g, " ");

  return toTitleCase(name);
}

function normalizeProductType(productType) {
  const value = String(productType || "")
    .trim()
    .replace(/^covering\./i, "");

  if (!value) {
    return "unknown";
  }

  if (value.toLowerCase() === "wood") {
    return "hardwood";
  }

  if (value.toLowerCase() === "luxuryvinyl") {
    return "lvt";
  }

  if (value.toLowerCase() === "carpettile") {
    return "carpet_tile";
  }
  return value;
}

function collectImageUris(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }

        if (entry && typeof entry === "object" && entry.uri) {
          return String(entry.uri).trim();
        }

        return "";
      })
      .filter(Boolean);
  }

  if (typeof value === "object") {
    return Object.values(value)
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }

        if (entry && typeof entry === "object" && entry.uri) {
          return String(entry.uri).trim();
        }

        return "";
      })
      .filter(Boolean);
  }

  return [];
}

function collectImageUrisText(value) {
  return collectImageUris(value).join("|");
}

function normalizeFacetRange(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const min = value.min ?? "";
  const max = value.max ?? "";
  if (min === "" && max === "") {
    return "";
  }

  return `${min}-${max}`;
}

function processArrayField(value) {
  const coerced = coerceExportValue(value);
  if (Array.isArray(coerced)) {
    const unique = [...new Set(coerced.map(String))];
    return unique.join(", ");
  }
  return coerced;
}

function isWebVisualizable(product) {
  const values = Array.isArray(product?.context?.merchandising)
    ? product.context.merchandising
    : [];

  return values.includes("webVisualizable") ? "Yes" : "No";
}

function isWebInStock(product) {
  const values = Array.isArray(product?.context?.merchandising)
    ? product.context.merchandising
    : [];

  return values.includes("webInStock") ? 1 : 0;
}

function getWebSampleSku(product) {
  const values = Array.isArray(product?.context?.merchandising)
    ? product.context.merchandising
    : [];

  if (values.includes("webSampled")) {
    return coerceExportValue(getNestedValue(product, "refCodes.sku"));
  }

  return "";
}

function getClassificationValue(product, fieldName) {
  return (
    getNestedValue(product, `classification.${fieldName}`) ??
    getNestedValue(product, `classification.characteristics.${fieldName}`)
  );
}

function hasExportValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function mapProductForExport(product) {
  const codeValue = coerceExportValue(getNestedValue(product, "code"));
  const skuValue = coerceExportValue(getNestedValue(product, "refCodes.sku"));
  const productType = normalizeProductType(
    getNestedValue(product, "classification.baseItemType"),
  );
  const installationType =
    getNestedValue(
      product,
      "classification.characteristics.installationType",
    ) ??
    getNestedValue(product, "classification.characteristics.installationTypes");

  const applicationValue = (() => {
    const val =
      getNestedValue(product, "classification.usageContexts") ??
      getNestedValue(product, "classification.characteristics.usageContexts");
    if (Array.isArray(val)) {
      const uniqueValues = new Map();
      val.forEach((item) => {
        const value = String(item || "").trim();
        if (value) {
          uniqueValues.set(value.toLowerCase(), value);
        }
      });
      return [...uniqueValues.values()]
        .sort((a, b) => b.localeCompare(a, undefined, { sensitivity: "base" }))
        .join(" / ");
    }
    return coerceExportValue(val);
  })();

  // Pre-compute processed fields
  const processedFinish = processArrayField(
    getNestedValue(product, "classification.characteristics.finish"),
  );
  const processedSurfaceTexture = processArrayField(
    getNestedValue(product, "classification.characteristics.finish"),
  );
  const styleValue = coerceExportValue(
    getNestedValue(
      product,
      "classification.characteristics.carpetConstruction",
    ),
  );
  const shadeValue = coerceExportValue(
    getNestedValue(product, "classification.characteristics.colorTone"),
  );
  const fiberValue = processArrayField(
    getClassificationValue(product, "fiberType") ??
      getClassificationValue(product, "fiberGroup"),
  );
  const waterProtectionValue = processArrayField(
    getClassificationValue(product, "waterProtection"),
  );
  const waterproofValue = /water(?:[\s_-]*)?(?:proof|resistant)/i.test(
    String(waterProtectionValue),
  )
    ? "Yes"
    : "No";
  const widthValue = coerceExportValue(
    getNestedValue(product, "dimensions.width.defaultValue"),
  );
  const lengthValue = coerceExportValue(
    getNestedValue(product, "dimensions.depth.defaultValue"),
  );
  const sizeValue =
    hasExportValue(widthValue) && hasExportValue(lengthValue)
      ? `${widthValue} x ${lengthValue}`
      : "";

  const exportItem = {
    application: applicationValue,
    application_facet: toTitleCase(applicationValue),
    backing: coerceExportValue(
      getNestedValue(product, "classification.characteristics.backingMaterial"),
    ),
    backing_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(
          product,
          "classification.characteristics.backingMaterial",
        ),
      ),
    ),
    brand: coerceExportValue(getNestedValue(product, "brand.name")),
    brand_facet: toTitleCase(
      coerceExportValue(getNestedValue(product, "brand.name")),
    ),
    brand_collection: [
      getNestedValue(product, "brand.name"),
      getNestedValue(product, "collection.name"),
    ]
      .filter((value) => String(value || "").trim())
      .join(" "),
    collection_facet: toTitleCase(
      coerceExportValue(getNestedValue(product, "collection.name")),
    ),
    collection_name: coerceExportValue(
      getNestedValue(product, "collection.name"),
    ),
    color: coerceExportValue(getNestedValue(product, "names.main.en-US")),
    color_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(product, "classification.characteristics.colorFamily"),
      ),
    ),
    color_variation: coerceExportValue(
      getNestedValue(product, "classification.characteristics.colorVariation"),
    ),
    color_variation_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(
          product,
          "classification.characteristics.colorVariation",
        ),
      ),
    ),
    construction: coerceExportValue(
      getNestedValue(
        product,
        "classification.characteristics.constructionMethod",
      ),
    ),
    construction_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(
          product,
          "classification.characteristics.constructionMethod",
        ),
      ),
    ),
    custom: "",
    description: coerceExportValue(
      getNestedValue(product, "descriptions.main.en-US"),
    ),
    design: "",
    edge: coerceExportValue(
      getNestedValue(product, "classification.characteristics.edgeProfile"),
    ),
    finish: processedFinish,
    fiber: fiberValue,
    fiber_facet: toTitleCase(fiberValue),
    gallery_images: collectImageUrisText(
      getNestedValue(product, "images.others"),
    ),
    in_stock: isWebInStock(product),
    install_location: coerceExportValue(
      getNestedValue(
        product,
        "classification.characteristics.installationGrade",
      ),
    ),
    installation: toTitleCase(coerceExportValue(installationType)),
    installation_facet: toTitleCase(coerceExportValue(installationType)),
    length: lengthValue,
    location: coerceExportValue(
      getNestedValue(
        product,
        "classification.characteristics.installationGrade",
      ),
    ),
    location_facet: coerceExportValue(
      getNestedValue(
        product,
        "classification.characteristics.installationGrade",
      ),
    ),
    look: coerceExportValue(
      getNestedValue(product, "classification.characteristics.look"),
    ),
    look_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(product, "classification.characteristics.look"),
      ),
    ),
    material: coerceExportValue(
      getNestedValue(product, "classification.characteristics.material") ??
        getNestedValue(product, "classification.characteristics.fiberBrand"),
    ),
    material_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(product, "classification.characteristics.material") ??
          getNestedValue(product, "classification.characteristics.fiberBrand"),
      ),
    ),
    msrp: "",
    msrp_unit_price: "",
    name: deriveProductNameFromCode(codeValue, skuValue),
    price: coerceExportValue(
      getNestedValue(product, "refCodes.others.pricing"),
    ),
    price_cut: "",
    price_unit: "",
    sample_sku: getWebSampleSku(product),
    shade: shadeValue,
    shade_facet: toTitleCase(shadeValue),
    shade_variation_facet: toTitleCase(shadeValue),
    shape: coerceExportValue(
      getNestedValue(product, "classification.characteristics.shape") ??
        getNestedValue(product, "classification.characteristics.look"),
    ),
    shape_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(product, "classification.characteristics.shape") ??
          getNestedValue(product, "classification.characteristics.look"),
      ),
    ),
    size: sizeValue,
    size_facet: sizeValue,
    sku: skuValue,
    species: coerceExportValue(
      getNestedValue(product, "classification.characteristics.woodSpecies"),
    ),
    species_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(product, "classification.characteristics.woodSpecies"),
      ),
    ),
    style: styleValue,
    style_facet: toTitleCase(styleValue),
    style_code: coerceExportValue(getNestedValue(product, "styleNumber")),
    sub_brand: coerceExportValue(getNestedValue(product, "collection.name")),
    sub_type: coerceExportValue(getNestedValue(product, "subProductTypeName")),
    surface_texture: processedSurfaceTexture,
    surface_texture_facet: toTitleCase(processedSurfaceTexture),
    surface_type: "",
    swatch: coerceExportValue(getNestedValue(product, "images.main.uri")),
    thickness: coerceExportValue(
      getNestedValue(product, "dimensions.height.defaultValue"),
    ),
    thickness_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(product, "dimensions.height.defaultValue"),
      ),
    ),
    manufacturer: coerceExportValue(
      getNestedValue(product, "catalogDependency.manufacturer") ??
        getNestedValue(product, "catalogDependency.manufCode") ??
        getNestedValue(product, "refCodes.manufCode"),
    ),
    status: product?.visible ? "active" : "inactive",
    upid: coerceExportValue(
      (() => {
        const itemRef = String(product?.itemRef || "").trim();
        const itemRefParts = itemRef.split(":");
        return itemRefParts.length > 1 ? itemRefParts[1] : "";
      })(),
    ),
    url_key: codeValue,
    visualizable: isWebVisualizable(product),
    waterproof: waterproofValue,
    warranty_text: coerceExportValue(
      getNestedValue(product, "descriptions.others.residentialWarranty.en-US"),
    ),
    wear_layer: coerceExportValue(
      getNestedValue(product, "descriptions.others.wearLayerMaterial.en-US"),
    ),
    wear_layer_thickness: coerceExportValue(
      getNestedValue(
        product,
        "classification.characteristics.wearLayerThickness",
      ),
    ),
    wear_layer_thickness_facet: toTitleCase(
      coerceExportValue(
        getNestedValue(
          product,
          "classification.characteristics.wearLayerThickness",
        ),
      ),
    ),
    weight: coerceExportValue(
      getNestedValue(
        product,
        "classification.characteristics.faceWeightPerArea",
      ),
    ),
    width: widthValue,
    width_facet: toTitleCase(
      normalizeFacetRange(getNestedValue(product, "dimensions.width.range")),
    ),
    z_prod_type: productType,
  };

  return exportItem;
}

function buildProductTypeExports(fullDetails, lang, catalogVersionId) {
  const catalogName = getCatalogNameByVersionId(lang, catalogVersionId);
  const catalogDir = generatedCatalogDirPath(catalogName);
  const groupedExports = new Map();

  fs.mkdirSync(catalogDir, { recursive: true });
  normalizeLegacyGeneratedProductTypeFiles(catalogDir);

  (Array.isArray(fullDetails) ? fullDetails : []).forEach((product) => {
    const productType = normalizeProductType(
      getNestedValue(product, "classification.baseItemType"),
    );
    if (productType === "unknown") {
      return;
    }

    const exportItem = mapProductForExport(product);
    const currentItems = groupedExports.get(productType) || [];
    currentItems.push(exportItem);
    groupedExports.set(productType, currentItems);
  });

  const files = Array.from(groupedExports.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([productType, items]) => {
      const fileName = getGeneratedProductTypeFileName(productType);
      const filePath = path.join(catalogDir, fileName);
      writeJsonFile(filePath, items, true);

      return {
        productType,
        fileName,
        filePath,
        total: items.length,
      };
    });

  pruneStaleGeneratedProductTypeFiles(
    catalogDir,
    files.map((file) => file.fileName),
  );

  return {
    catalogName,
    catalogDir,
    totalFiles: files.length,
    totalProducts: files.reduce((total, file) => total + file.total, 0),
    files,
  };
}

function getProductTypeExportJobKey(lang, catalogVersionId) {
  return `${lang}::${catalogVersionId}`;
}

function getProductTypeExportJobStatus(lang, catalogVersionId) {
  return (
    productTypeExportJobs.get(
      getProductTypeExportJobKey(lang, catalogVersionId),
    ) || null
  );
}

function setProductTypeExportJobStatus(lang, catalogVersionId, job) {
  productTypeExportJobs.set(
    getProductTypeExportJobKey(lang, catalogVersionId),
    {
      ...job,
      updatedAt: new Date().toISOString(),
    },
  );
}

function startProductTypeExportJob(fullDetails, lang, catalogVersionId) {
  const existingJob = getProductTypeExportJobStatus(lang, catalogVersionId);

  if (existingJob?.status === "running") {
    return {
      status: "running",
      started: false,
      job: existingJob,
    };
  }

  const initialJob = {
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    total: Array.isArray(fullDetails) ? fullDetails.length : 0,
    error: "",
    result: null,
  };

  setProductTypeExportJobStatus(lang, catalogVersionId, initialJob);

  setImmediate(() => {
    try {
      const result = buildProductTypeExports(
        fullDetails,
        lang,
        catalogVersionId,
      );
      setProductTypeExportJobStatus(lang, catalogVersionId, {
        ...initialJob,
        status: "ready",
        result,
      });
    } catch (error) {
      setProductTypeExportJobStatus(lang, catalogVersionId, {
        ...initialJob,
        status: "failed",
        error: error.message || "Failed to generate product JSON files.",
      });
    }
  });

  return {
    status: "running",
    started: true,
    job: initialJob,
  };
}

function buildProductTypeExportResponse(
  job,
  cachePayload,
  lang,
  catalogVersionId,
) {
  if (job?.status === "ready" && job.result) {
    const files = Array.isArray(job.result.files)
      ? job.result.files.filter((file) => file.productType !== "unknown")
      : [];
    return {
      status: "ready",
      message: "Product JSON files generated successfully.",
      metadata: {
        catalogVersionId,
        lang,
        updatedAt: job.updatedAt,
        fullDetailsUpdatedAt: cachePayload?.updatedAt,
      },
      ...job.result,
      totalFiles:
        typeof job.result.totalFiles === "number"
          ? files.length
          : job.result.totalFiles,
      totalProducts: files.reduce(
        (total, file) => total + (Number(file.total) || 0),
        0,
      ),
      files,
    };
  }

  return {
    status: job?.status || "running",
    message:
      job?.status === "failed"
        ? job.error || "Failed to generate product JSON files."
        : "Product JSON file generation is running.",
    metadata: {
      catalogVersionId,
      lang,
      startedAt: job?.startedAt || new Date().toISOString(),
      updatedAt: job?.updatedAt || new Date().toISOString(),
      total: job?.total || 0,
      fullDetailsUpdatedAt: cachePayload?.updatedAt,
      error: job?.error || "",
    },
  };
}

function readGeneratedProductTypeFiles(catalogName, catalogId = "") {
  const catalogDir = generatedCatalogDirPath(catalogName);
  const files = listJsonFiles(catalogDir);
  const types = {};
  const availableTypes = [];

  for (const fileName of files) {
    const typeName = fileName.replace(/\.json$/i, "");
    if (typeName === "unknown") {
      continue;
    }

    const filePath = path.join(catalogDir, fileName);
    const parsed = readJsonFile(filePath);

    if (!parsed) {
      continue;
    }

    types[typeName] = parsed;
    availableTypes.push({
      type: typeName,
      filename: fileName,
      size: fs.statSync(filePath).size,
      url: catalogId
        ? `/api/refresh-all/${catalogId}/types/${encodeURIComponent(typeName)}`
        : "",
    });
  }

  return {
    catalogDir,
    types,
    availableTypes,
  };
}

function getGeneratedCatalogName(lang, catalogId) {
  return getCatalogNameByVersionId(lang, catalogId);
}

function getParentDependencyKey(itemRef) {
  const value = String(itemRef || "").trim();
  if (!value) {
    return "";
  }

  return value.split(":")[0]?.trim() || "";
}

function getParentCatalogIdFromDependencyKey(parentDependencyKey) {
  if (!parentDependencyKey || !parentDependencyKey.includes("-")) {
    return "";
  }

  return parentDependencyKey.split("-").pop()?.trim() || "";
}

function buildFullDetailsPreview(fullDetails) {
  return fullDetails.slice(0, FULL_DETAILS_PREVIEW_LIMIT);
}

function buildFullDetailsMetadata(baseMetadata, fullDetails, extra = {}) {
  const {
    productsCompleted: _productsCompleted,
    productsProgressPercent: _productsProgressPercent,
    productsStatus: _productsStatus,
    ...metadata
  } = baseMetadata || {};

  return {
    ...metadata,
    fullDetailsTotal: Array.isArray(fullDetails) ? fullDetails.length : 0,
    previewCount: Math.min(
      Array.isArray(fullDetails) ? fullDetails.length : 0,
      FULL_DETAILS_PREVIEW_LIMIT,
    ),
    cacheFile: path.basename(
      fullDetailsCacheFilePath(extra.lang, extra.catalogVersionId),
    ),
    ...extra,
  };
}

function buildFullDetailsJobMetadata(lang, catalogVersionId, job = {}) {
  const completed = job?.completed || 0;
  const total = job?.total || 0;

  return {
    catalogVersionId,
    lang,
    isFresh: false,
    status: job?.status || "running",
    startedAt: job?.startedAt || new Date().toISOString(),
    updatedAt: job?.updatedAt || new Date().toISOString(),
    completed,
    total,
    progressPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
    productsSource: job?.productsSource || "",
    productsUpdatedAt: job?.productsUpdatedAt || "",
    currentStep: job?.currentStep || "",
    itemDetails: job?.itemDetails || null,
    logs: Array.isArray(job?.logs) ? job.logs : [],
    cacheFile: path.basename(fullDetailsCacheFilePath(lang, catalogVersionId)),
  };
}

// OPTIMIZATION: Global job queue to prevent system overload
const jobQueueStats = {
  activeJobs: new Map(), // Track active jobs per catalog
  maxConcurrentJobs: Math.min(3, Math.ceil(os.cpus().length / 4)), // Limit concurrent full refreshes
};

function logFullDetails(message, details) {
  if (details === undefined) {
    return {
      timestamp: new Date().toISOString(),
      message,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    message,
    details,
  };
}

function appendFullDetailsJobLog(lang, catalogVersionId, message, details) {
  const entry = logFullDetails(message, details);
  const job = getFullDetailsJobStatus(lang, catalogVersionId);

  if (!job) {
    return entry;
  }

  const nextLogs = [...(job.logs || []), entry].slice(-FULL_DETAILS_LOG_LIMIT);
  setFullDetailsJobStatus(lang, catalogVersionId, {
    ...job,
    logs: nextLogs,
    updatedAt: new Date().toISOString(),
  });

  return entry;
}

async function buildFullProductDetails(
  products,
  lang = "en-US",
  groupLookup = { groups: [], byRef: new Map() },
  catalogVersionId = "",
  onProgress = () => {},
  onLog = () => {},
  existingFullDetailsCache = null,
) {
  const catalogs = getCatalogItemsFromCache(lang);
  const productsToProcess = Array.isArray(products) ? products : [];
  let completed = 0;

  onLog("Starting full product detail build.", {
    lang,
    totalProducts: productsToProcess.length,
    catalogCount: Array.isArray(catalogs) ? catalogs.length : 0,
    groupCount: Array.isArray(groupLookup?.groups)
      ? groupLookup.groups.length
      : 0,
    concurrency: FULL_DETAILS_CONCURRENCY,
  });

  const catalog = findCatalogByVersionId(catalogs, catalogVersionId);
  const retailerCode = String(catalog?.code || "").trim();
  const catalogName = getCatalogNameByVersionId(lang, catalogVersionId);
  const fallbackCatalogDependencies = buildCatalogDependenciesFromCatalog(
    catalog,
    catalogVersionId,
  );
  onLog("Fetching catalog dependencies.", {
    catalogVersionId,
    catalogName,
    retailerCode,
    fallbackDependencyCount: Array.isArray(
      fallbackCatalogDependencies?.dependencies,
    )
      ? fallbackCatalogDependencies.dependencies.length
      : 0,
  });
  const catalogDependencies = await fetchCatalogDependencies(
    retailerCode,
    catalogName,
    fallbackCatalogDependencies,
  );
  onLog("Catalog dependencies fetched.", {
    catalogVersionId,
    dependencyCount: Array.isArray(catalogDependencies?.dependencies)
      ? catalogDependencies.dependencies.length
      : 0,
  });

  // OPTIMIZATION: Pre-compute dependency lookup map to avoid repeated searches
  const dependencyLookup = buildDependencyLookup(catalogDependencies);
  const latestVersionByCatalogId = buildCatalogVersionLookup(catalogs);
  let itemDetailsPersistentCache = seedItemDetailsCacheFromFullDetails(
    existingFullDetailsCache,
    readItemDetailsCache(lang, catalogVersionId),
  );
  const itemDetailsStats = {
    memoryHits: 0,
    diskHits: 0,
    seededHits: 0,
    fetched: 0,
    errors: 0,
  };
  // OPTIMIZATION: Pre-compute group products map for faster lookup
  const groupProductsMap = buildGroupProductsMap(groupLookup);

  const fullDetails = await mapWithConcurrency(
    productsToProcess,
    async (product, index) => {
      // OPTIMIZATION: Reduced logging - only on errors or milestones
      const logThreshold = Math.max(
        100,
        Math.floor(productsToProcess.length / 20),
      );
      const shouldLog = index === 0 || (index + 1) % logThreshold === 0;

      if (shouldLog) {
        onLog("Processing product batch.", {
          index: index + 1,
          totalProducts: productsToProcess.length,
          itemRef: product?.itemRef || "",
        });
      }

      const itemRefParts = String(product?.itemRef || "").split(":");
      const parentDependencyKey = itemRefParts[0]?.trim() || "";
      const itemRefProductCode = itemRefParts[1]?.trim() || "";

      // OPTIMIZATION: Use pre-computed lookup instead of searching catalogs repeatedly
      const parentCatalogVersionId = parentDependencyKey
        ? latestVersionByCatalogId.get(
            getParentCatalogIdFromDependencyKey(parentDependencyKey),
          )
        : null;

      // OPTIMIZATION: Use pre-computed dependency lookup
      const productDependencyData =
        parentDependencyKey && dependencyLookup?.byKey
          ? dependencyLookup.byKey[parentDependencyKey.toLowerCase()]
          : null;

      // OPTIMIZATION: Use pre-computed groups lookup
      const productGroups =
        product?.groupRefs && groupProductsMap
          ? buildProductGroupsOptimized(product.groupRefs, groupProductsMap)
          : { brand: null, collection: null };

      // OPTIMIZATION: Extract manufacturer once instead of nested ternaries
      const dependencyManufacturer = extractManufacturerName(
        itemRefParts[0],
        productDependencyData,
        dependencyLookup,
      );

      const parentItemId =
        parentCatalogVersionId && itemRefProductCode
          ? `${parentCatalogVersionId}.${itemRefProductCode}`
          : "";

      let itemDetails = null;
      let itemDetailsError = "";

      if (parentItemId) {
        if (itemDetailsMemoCache.has(parentItemId)) {
          itemDetails = itemDetailsMemoCache.get(parentItemId);
          itemDetailsStats.memoryHits += 1;
        } else if (itemDetailsPersistentCache.items[parentItemId]) {
          itemDetails = itemDetailsPersistentCache.items[parentItemId];
          rememberItemDetails(parentItemId, itemDetails);
          itemDetailsStats.diskHits += 1;
          if (existingFullDetailsCache?.fullDetails) {
            itemDetailsStats.seededHits += 1;
          }
        } else if (
          isCacheFresh(itemDetailsPersistentCache) &&
          itemDetailsPersistentCache.errors[parentItemId]
        ) {
          itemDetailsError = itemDetailsPersistentCache.errors[parentItemId];
          itemDetailsStats.errors += 1;
        } else {
          try {
            // OPTIMIZATION: Use memoized version to dedupe requests
            itemDetails = await fetchItemDetailsMemoized(parentItemId);
            itemDetailsPersistentCache.items[parentItemId] = itemDetails;
            delete itemDetailsPersistentCache.errors[parentItemId];
            itemDetailsStats.fetched += 1;
          } catch (error) {
            itemDetailsError = error.message || "Failed to fetch item details.";
            itemDetailsPersistentCache.errors[parentItemId] = itemDetailsError;
            itemDetailsStats.errors += 1;
          }
        }
      }

      // OPTIMIZATION: Build result object only with necessary fields
      // Avoid excessive spreading - only merge what's needed
      const result = buildMergedProduct(
        product,
        itemDetails,
        productGroups,
        productDependencyData,
        dependencyManufacturer,
        parentDependencyKey,
        getParentCatalogIdFromDependencyKey(parentDependencyKey),
        parentCatalogVersionId,
        parentItemId,
        itemDetailsError,
      );

      completed += 1;
      if (shouldLog || completed % logThreshold === 0) {
        onProgress({
          completed,
          total: productsToProcess.length,
          itemDetails: { ...itemDetailsStats },
        });
      }

      return result;
    },
    FULL_DETAILS_CONCURRENCY,
  );

  writeItemDetailsCache(lang, catalogVersionId, itemDetailsPersistentCache);
  onLog("Finished full product detail build.", {
    lang,
    totalProducts: productsToProcess.length,
    itemDetails: itemDetailsStats,
  });

  return fullDetails;
}

// OPTIMIZATION: Helper function to build dependency lookup map
function buildDependencyLookup(catalogDependencies) {
  const byKey = {};
  const manufacturerByKey = {};

  if (!catalogDependencies || typeof catalogDependencies !== "object") {
    return {
      byKey,
      manufacturerByKey,
    };
  }

  for (const key in catalogDependencies) {
    if (key !== "dependencies" && catalogDependencies[key] !== null) {
      byKey[key.toLowerCase()] = catalogDependencies[key];
    }
  }

  if (Array.isArray(catalogDependencies.dependencies)) {
    for (const dependency of catalogDependencies.dependencies) {
      const dependencyKey = String(dependency?.dependencyKey || "")
        .trim()
        .toLowerCase();
      if (!dependencyKey) {
        continue;
      }

      byKey[dependencyKey] = byKey[dependencyKey] || dependency;
      manufacturerByKey[dependencyKey] =
        dependency?.manufacturerName ||
        dependency?.manufacturer ||
        dependency?.manufCode ||
        dependency?.name ||
        dependency?.brand ||
        "";
    }
  }

  return {
    byKey,
    manufacturerByKey,
  };
}

function buildCatalogVersionLookup(catalogs) {
  const latestVersionByCatalogId = new Map();

  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    if (catalog?.id === undefined || catalog?.id === null) {
      continue;
    }

    const latestVersionId = getLatestCatalogVersionIdByCatalogId(
      [catalog],
      catalog.id,
    );
    if (latestVersionId) {
      latestVersionByCatalogId.set(String(catalog.id), latestVersionId);
    }
  }

  return latestVersionByCatalogId;
}

// OPTIMIZATION: Helper function to build group products map
function buildGroupProductsMap(groupLookup) {
  if (
    !groupLookup ||
    !groupLookup.byRef ||
    typeof groupLookup.byRef.get !== "function"
  ) {
    return null;
  }
  return groupLookup;
}

// OPTIMIZATION: Optimized group lookup
function buildProductGroupsOptimized(groupRefs, groupProductsMap) {
  let brand = null;
  let collection = null;

  if (Array.isArray(groupRefs)) {
    const groups = groupRefs
      .map((ref) => groupProductsMap?.byRef?.get(String(ref).trim()))
      .filter(Boolean);

    if (groups.length > 0) {
      for (const group of groups) {
        const kind = getGroupKind(group);
        if (kind === "brand" && !brand) {
          brand = simplifyGroup(group);
        } else if (kind === "collection" && !collection) {
          collection = simplifyGroup(group);
        }
      }
    }

    // Fallback for unclassified groups
    if ((!brand || !collection) && groups.length >= 2) {
      for (const group of groups) {
        if (!getGroupKind(group)) {
          if (!collection) {
            collection = simplifyGroup(group);
          } else if (!brand) {
            brand = simplifyGroup(group);
          }
        }
      }
    }
  }

  return { brand, collection };
}

// OPTIMIZATION: Extract manufacturer name without nested conditions
function extractManufacturerName(
  itemRefDependencyKey,
  productDependencyData,
  dependencyLookup,
) {
  if (!itemRefDependencyKey && !productDependencyData) {
    return null;
  }

  const normalizedKey = String(itemRefDependencyKey || "").toLowerCase();
  if (normalizedKey && dependencyLookup?.manufacturerByKey?.[normalizedKey]) {
    return dependencyLookup.manufacturerByKey[normalizedKey];
  }

  if (normalizedKey && dependencyLookup?.byKey?.[normalizedKey]) {
    const dependency = dependencyLookup.byKey[normalizedKey];
    const manufacturer =
      dependency?.manufacturerName ||
      dependency?.manufacturer ||
      dependency?.manufCode ||
      dependency?.name ||
      dependency?.brand ||
      null;

    if (manufacturer) {
      return manufacturer;
    }
  }

  // Fallback to product dependency data
  if (productDependencyData) {
    return (
      productDependencyData?.manufacturerName ||
      productDependencyData?.manufacturer ||
      productDependencyData?.manufCode ||
      productDependencyData?.name ||
      productDependencyData?.brand ||
      null
    );
  }

  return null;
}

// OPTIMIZATION: Build merged product with minimal object operations
function buildMergedProduct(
  product,
  itemDetails,
  productGroups,
  productDependencyData,
  dependencyManufacturer,
  parentDependencyKey,
  parentCatalogId,
  parentCatalogVersionId,
  parentItemId,
  itemDetailsError,
) {
  // Start with product as base
  const result = { ...product };

  // Merge itemDetails if exists (exclude id and code)
  if (itemDetails && typeof itemDetails === "object") {
    const { id, code, ...itemDetailsWithoutIdCode } = itemDetails;
    Object.assign(result, itemDetailsWithoutIdCode);
  }

  // Add groups if they exist
  if (productGroups.brand) {
    result.brand = productGroups.brand;
  }
  if (productGroups.collection) {
    result.collection = productGroups.collection;
  }

  // Add dependency data if exists
  if (productDependencyData && typeof productDependencyData === "object") {
    result.catalogDependency = productDependencyData;
  }

  // Add manufacturer if exists
  if (dependencyManufacturer) {
    result.manufacturer = dependencyManufacturer;
    result.refCodes = {
      ...(product?.refCodes || {}),
      manufCode: dependencyManufacturer,
    };
  }

  // Add enrichment metadata
  result.enrichment = {
    parentDependencyKey,
    parentCatalogId,
    parentCatalogVersionId,
    parentItemId,
    itemDetailsError,
  };

  return result;
}

function getFullDetailsJobKey(lang, catalogVersionId) {
  return `${lang}::${catalogVersionId}`;
}

function getFullDetailsJobStatus(lang, catalogVersionId) {
  return (
    fullDetailsJobs.get(getFullDetailsJobKey(lang, catalogVersionId)) || null
  );
}

function setFullDetailsJobStatus(lang, catalogVersionId, job) {
  fullDetailsJobs.set(getFullDetailsJobKey(lang, catalogVersionId), job);
}

function clearFullDetailsJobStatus(lang, catalogVersionId) {
  fullDetailsJobs.delete(getFullDetailsJobKey(lang, catalogVersionId));
}

// OPTIMIZATION: Job queue management to prevent system overload
function canStartNewJob() {
  let activeCount = 0;
  for (const job of jobQueueStats.activeJobs.values()) {
    if (job.status === "running") {
      activeCount++;
    }
  }
  return activeCount < jobQueueStats.maxConcurrentJobs;
}

function registerActiveJob(jobKey, catalogVersionId) {
  jobQueueStats.activeJobs.set(jobKey, {
    catalogVersionId,
    status: "running",
    startedAt: Date.now(),
  });
}

function unregisterActiveJob(jobKey) {
  jobQueueStats.activeJobs.delete(jobKey);
}

async function ensureFullDetailsCache(
  catalogVersionId,
  lang,
  forceRefresh = false,
) {
  const cachedFullDetails = readFullDetailsCache(lang, catalogVersionId);
  const hasFreshCache = isCacheFresh(cachedFullDetails);
  const existingJob = getFullDetailsJobStatus(lang, catalogVersionId);
  const jobKey = getFullDetailsJobKey(lang, catalogVersionId);

  if (existingJob?.status === "running") {
    return {
      status: "running",
      job: existingJob,
      started: false,
    };
  }

  if (forceRefresh) {
    clearFullDetailsJobStatus(lang, catalogVersionId);
    writeItemDetailsCache(lang, catalogVersionId, {
      items: {},
      errors: {},
    });
    itemDetailsMemoCache.clear();
    itemDetailsRequestQueue.clear();
  }

  if (
    !forceRefresh &&
    existingJob?.status === "ready" &&
    hasFreshCache &&
    Array.isArray(cachedFullDetails?.fullDetails)
  ) {
    return {
      status: "ready",
      cachePayload: cachedFullDetails,
      started: false,
    };
  }

  const cachedFullDetailsCount = Array.isArray(cachedFullDetails?.fullDetails)
    ? cachedFullDetails.fullDetails.length
    : 0;

  appendFullDetailsJobLog(
    lang,
    catalogVersionId,
    "ensureFullDetailsCache called.",
    {
      catalogVersionId,
      lang,
      forceRefresh,
      hasFreshCache,
      cachedCount: cachedFullDetailsCount,
    },
  );

  if (!forceRefresh && hasFreshCache && cachedFullDetailsCount > 0) {
    return {
      status: "ready",
      cachePayload: cachedFullDetails,
      started: false,
    };
  }

  const preparingJob = {
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completed: 0,
    total: cachedFullDetailsCount,
    productsSource: "",
    productsUpdatedAt: "",
    currentStep: "Preparing full-details refresh.",
    error: "",
    logs: [],
  };
  setFullDetailsJobStatus(lang, catalogVersionId, preparingJob);
  registerActiveJob(jobKey, catalogVersionId);

  appendFullDetailsJobLog(lang, catalogVersionId, "Started full-details job.", {
    catalogVersionId,
    lang,
    forceRefresh,
  });

  // OPTIMIZATION: Only log when starting new job
  const productCache = readProductCache(lang, catalogVersionId);
  let items = Array.isArray(productCache?.items) ? productCache.items : [];
  let itemsPath = productCache?.metadata?.itemsPath || "cache";
  let productsSource = items.length ? "cache" : "";
  let productsUpdatedAt = productCache?.updatedAt || "";
  let derivedTotal = Array.isArray(productCache?.items)
    ? productCache.items.length
    : Number(productCache?.metadata?.total) || 0;

  if (!items.length || forceRefresh) {
    try {
      setFullDetailsJobStatus(lang, catalogVersionId, {
        ...getFullDetailsJobStatus(lang, catalogVersionId),
        currentStep: "Refreshing product cache.",
        updatedAt: new Date().toISOString(),
      });
      appendFullDetailsJobLog(
        lang,
        catalogVersionId,
        "Refreshing products before full-details generation.",
        {
          catalogVersionId,
          lang,
          reason: !items.length ? "products cache missing" : "force refresh",
        },
      );
      const payload = await fetchProductsByCatalogVersionId(catalogVersionId);
      const extracted = extractItemsFromPayload(payload);
      items = extracted.items;
      itemsPath = extracted.path;
      derivedTotal = Array.isArray(items) ? items.length : 0;
      const productsMetadata = {
        catalogVersionId,
        total: derivedTotal,
        itemsPath,
        source: "api",
        lang,
        isFresh: true,
        forceRefresh,
      };
      const savedProducts = writeProductCache(lang, catalogVersionId, {
        items,
        metadata: productsMetadata,
        raw: payload,
      });
      productsSource = "api";
      productsUpdatedAt = savedProducts.updatedAt;
    } catch (error) {
      const failedJob = {
        ...getFullDetailsJobStatus(lang, catalogVersionId),
        status: "failed",
        updatedAt: new Date().toISOString(),
        currentStep: "Full-details refresh stopped.",
        error: error.message || "Failed to refresh products.",
      };
      setFullDetailsJobStatus(lang, catalogVersionId, failedJob);
      appendFullDetailsJobLog(
        lang,
        catalogVersionId,
        "Full-details refresh failed while refreshing products.",
        { catalogVersionId, lang, error: failedJob.error },
      );
      unregisterActiveJob(jobKey);
      return {
        status: "failed",
        job: failedJob,
        started: false,
      };
    }
  }

  if (derivedTotal === 0 && cachedFullDetailsCount > 0) {
    derivedTotal = cachedFullDetailsCount;
  }

  if (derivedTotal === 0) {
    const fileCount = countFullDetailsCacheEntries(lang, catalogVersionId);
    if (fileCount > 0) {
      derivedTotal = fileCount;
    }
  }

  if (derivedTotal === 0) {
    const failedJob = {
      status: "failed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completed: 0,
      total: 0,
      error:
        "Unable to determine total product count from source data. Stopping refresh.",
      logs: [
        logFullDetails(
          "Full-details refresh aborted because total count could not be determined.",
          { catalogVersionId, lang },
        ),
      ],
    };

    setFullDetailsJobStatus(lang, catalogVersionId, failedJob);
    appendFullDetailsJobLog(
      lang,
      catalogVersionId,
      "Full-details refresh aborted because total count could not be determined.",
      { catalogVersionId, lang, derivedTotal },
    );
    unregisterActiveJob(jobKey);

    return {
      status: "failed",
      job: failedJob,
      started: false,
    };
  }

  const currentJob = getFullDetailsJobStatus(lang, catalogVersionId) || {};
  const initialJob = {
    ...currentJob,
    status: "running",
    startedAt: currentJob.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completed: 0,
    total: derivedTotal,
    productsSource,
    productsUpdatedAt,
    currentStep: "Starting full-details refresh.",
    error: "",
  };
  setFullDetailsJobStatus(lang, catalogVersionId, initialJob);

  const jobPromise = (async () => {
    try {
      let groupLookup = { groups: [], byRef: new Map() };
      try {
        setFullDetailsJobStatus(lang, catalogVersionId, {
          ...getFullDetailsJobStatus(lang, catalogVersionId),
          currentStep: "Fetching product groups.",
          updatedAt: new Date().toISOString(),
        });
        const groupsPayload = await fetchGroupsByCatalogVersionId(
          catalogVersionId,
          lang,
        );
        groupLookup = buildGroupLookup(groupsPayload);
      } catch (error) {
        // OPTIMIZATION: Only log fetch errors, don't log every fetch attempt
        appendFullDetailsJobLog(
          lang,
          catalogVersionId,
          "Group enrichment unavailable. Continuing full-details generation.",
          { catalogVersionId, lang, error: error.message || String(error) },
        );
      }

      // OPTIMIZATION: Simplified progress updates - only on job state change
      setFullDetailsJobStatus(lang, catalogVersionId, {
        ...getFullDetailsJobStatus(lang, catalogVersionId),
        total: derivedTotal,
        currentStep: "Fetching catalog dependencies.",
        updatedAt: new Date().toISOString(),
      });

      const fullDetails = await buildFullProductDetails(
        items,
        lang,
        groupLookup,
        catalogVersionId,
        ({ completed, total, itemDetails }) => {
          // OPTIMIZATION: Update job state with reduced overhead
          const currentJob = getFullDetailsJobStatus(lang, catalogVersionId);
          setFullDetailsJobStatus(lang, catalogVersionId, {
            ...currentJob,
            status: "running",
            currentStep: "Building full product details.",
            completed,
            total,
            itemDetails,
            updatedAt: new Date().toISOString(),
          });
        },
        (message, details) => {
          appendFullDetailsJobLog(lang, catalogVersionId, message, details);
        },
        forceRefresh ? null : cachedFullDetails,
      );

      // OPTIMIZATION: Batch write and minimal logging on completion
      const saved = writeFullDetailsCache(lang, catalogVersionId, {
        fullDetails,
        metadata: buildFullDetailsMetadata(
          {
            catalogVersionId,
            total: items.length,
            itemsPath,
            source: "api",
            lang,
            isFresh: true,
            forceRefresh,
            productsTotal: items.length,
            productsCompleted: items.length,
            productsProgressPercent: items.length > 0 ? 100 : 0,
            productsSource,
            productsStatus: "ready",
            productsUpdatedAt,
          },
          fullDetails,
          {
            catalogVersionId,
            lang,
            status: "ready",
          },
        ),
      });

      const completedJob = getFullDetailsJobStatus(lang, catalogVersionId);
      setFullDetailsJobStatus(lang, catalogVersionId, {
        ...completedJob,
        status: "ready",
        startedAt: initialJob.startedAt,
        updatedAt: new Date().toISOString(),
        completed: items.length,
        total: items.length,
        currentStep: "Full-details refresh complete.",
        error: "",
      });

      appendFullDetailsJobLog(
        lang,
        catalogVersionId,
        "Full-details job completed successfully.",
        { catalogVersionId, lang, total: items.length },
      );

      return saved;
    } catch (error) {
      appendFullDetailsJobLog(
        lang,
        catalogVersionId,
        "Full-details job failed.",
        { catalogVersionId, lang, error: error.message },
      );
      const failedJob = getFullDetailsJobStatus(lang, catalogVersionId);
      setFullDetailsJobStatus(lang, catalogVersionId, {
        ...failedJob,
        status: "failed",
        currentStep: "Full-details refresh stopped.",
        error: error.message || "Failed to build full details cache.",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      // OPTIMIZATION: Clean up active job tracking
      unregisterActiveJob(jobKey);
    }
  })();
  jobPromise.catch(() => {});

  return {
    status: "running",
    job: initialJob,
    started: true,
    jobPromise,
  };
}

registerApiRoutes(app, {
  path,
  fs,
  cacheDir,
  generatedDir,
  readCache,
  writeCache,
  readProductCache,
  writeProductCache,
  readFullDetailsCache,
  fullDetailsCacheFilePath,
  productCacheFilePath,
  generatedCatalogDirPath,
  isCacheFresh,
  fetchCatalogsFromApi,
  fetchProductsByCatalogVersionId,
  extractItemsFromPayload,
  ensureFullDetailsCache,
  getFullDetailsJobStatus,
  buildFullDetailsPreview,
  buildFullDetailsMetadata,
  buildFullDetailsJobMetadata,
  getCatalogNameByVersionId,
  buildFileMetadata,
  listJsonFiles,
  sanitizeFileSegment,
  findCatalogBySiteCode,
  isPathInside,
  writeZipFileToResponse,
  getCatalogItemsFromCache,
  findCatalogByVersionId,
  deleteProductCache,
  deleteFullDetailsCache,
  deleteItemDetailsCache,
  clearFullDetailsJobStatus,
  productTypeExportJobs,
  getProductTypeExportJobKey,
  unregisterActiveJob,
  getFullDetailsJobKey,
  catalogDependencyCacheFilePath,
  deleteDirectoryIfExists,
  itemDetailsMemoCache,
  itemDetailsRequestQueue,
  getProductTypeExportJobStatus,
  buildProductTypeExports,
  buildProductTypeExportResponse,
  setProductTypeExportJobStatus,
  getGeneratedCatalogName,
  readGeneratedProductTypeFiles,
  readJsonFile,
  startProductTypeExportJob,
  normalizeLegacyGeneratedProductTypeFiles,
  getGeneratedProductTypeFileName,
  getProductTypeFromGeneratedFileName,
  isGeneratedProductTypeFileName,
});

registerAuthRoutes(app, authRepository, requireAuth);

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const { scheduleNextDailyRefresh } = createDailyRefreshScheduler(app, {
  ensureFullDetailsCache,
  readProductCache,
  readFullDetailsCache,
  buildProductTypeExports,
  setProductTypeExportJobStatus,
  getFullDetailsJobStatus,
  getCatalogItemsFromCache,
  readJsonFile,
  writeJsonFile,
  readCatalogDependencyCache,
  writeCatalogDependencyCache,
  dailyRefreshSelectionFilePath,
  pruneDailyRefreshCache,
  catalogSelectionRepository,
  requireAuth,
});

app.use((error, _req, res, _next) => {
  console.error("Request failed:", error?.message || error);
  if (res.headersSent) return;
  res.status(500).json({ message: "Internal server error." });
});

async function startServer() {
  const serviceRole = String(process.env.SERVICE_ROLE || "api").toLowerCase();
  console.log("Starting server...");
  console.log("Initializing database...");

  await initializeDatabase();

  console.log("Database initialized.");

  if (serviceRole === "scheduler") {
    await scheduleNextDailyRefresh();
    console.log("CIC scheduler worker running.");
    return;
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Unable to start server:", error.message || error);
  process.exitCode = 1;
});
