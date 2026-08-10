const registerApiRoutes = (app, dependencies) => {
  const {
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
  } = dependencies;

  const normalizeGeneratedFiles =
    typeof normalizeLegacyGeneratedProductTypeFiles === "function"
      ? normalizeLegacyGeneratedProductTypeFiles
      : (catalogDir) => {
          if (!catalogDir || !fs.existsSync(catalogDir)) {
            return [];
          }

          const normalized = [];
          for (const entryName of fs.readdirSync(catalogDir)) {
            const entryPath = path.join(catalogDir, entryName);
            if (!entryName.toLowerCase().endsWith(".json")) {
              continue;
            }

            const targetFileName = `cic_${sanitizeFileSegment(
              path.basename(entryName, ".json"),
              "unknown",
            )}.json`;
            const targetPath = path.join(catalogDir, targetFileName);

            if (fs.existsSync(targetPath)) {
              fs.unlinkSync(entryPath);
              continue;
            }

            fs.renameSync(entryPath, targetPath);
            normalized.push(targetFileName);
          }

          return normalized;
        };

  const buildGeneratedProductTypeFileName =
    typeof getGeneratedProductTypeFileName === "function"
      ? getGeneratedProductTypeFileName
      : (productType) =>
          `cic_${sanitizeFileSegment(productType, "unknown")}.json`;

  const readGeneratedProductTypeName =
    typeof getProductTypeFromGeneratedFileName === "function"
      ? getProductTypeFromGeneratedFileName
      : (fileName) => {
          const baseName = path.basename(String(fileName || ""), ".json");
          return baseName.replace(/^cic_/i, "");
        };

  const isGeneratedProductTypeFile =
    typeof isGeneratedProductTypeFileName === "function"
      ? isGeneratedProductTypeFileName
      : (fileName) => /^cic_[^\/]+\.json$/i.test(String(fileName || ""));

  function streamJsonFileDownload(req, res, filePath, downloadFileName) {
    const stats = fs.statSync(filePath);
    const range = req.headers.range;
    let start = 0;
    let end = stats.size - 1;
    let statusCode = 200;

    if (range) {
      const match = String(range).match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const requestedStart = match[1] ? Number(match[1]) : 0;
        const requestedEnd = match[2] ? Number(match[2]) : stats.size - 1;

        if (
          Number.isFinite(requestedStart) &&
          Number.isFinite(requestedEnd) &&
          requestedStart <= requestedEnd &&
          requestedStart < stats.size
        ) {
          start = requestedStart;
          end = Math.min(requestedEnd, stats.size - 1);
          statusCode = 206;
        } else {
          res.setHeader("Content-Range", `bytes */${stats.size}`);
          return res.status(416).end();
        }
      }
    }

    const contentLength = end - start + 1;

    res.status(statusCode);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadFileName}"`,
    );
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", String(contentLength));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    if (statusCode === 206) {
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stats.size}`);
    }

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const stream = fs.createReadStream(filePath, {
      start,
      end,
      highWaterMark: 1024 * 1024,
    });

    stream.on("error", (error) => {
      if (!res.headersSent) {
        res.status(500).json({
          message: error.message || "Failed to stream download file.",
        });
        return;
      }

      res.destroy(error);
    });

    stream.pipe(res);
  }

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/catalogs", async (req, res) => {
    const lang = req.query.lang || "en-US";
    const forceRefresh =
      String(req.query.force || "false").toLowerCase() === "true";
    const cachePayload = readCache(lang);
    const hasFreshCache = isCacheFresh(cachePayload);

    if (!forceRefresh && hasFreshCache) {
      return res.json({
        items: cachePayload.items || [],
        metadata: {
          source: "cache",
          lang,
          updatedAt: cachePayload.updatedAt,
          isFresh: true,
        },
      });
    }

    try {
      const items = await fetchCatalogsFromApi(lang);
      const saved = writeCache(lang, items);
      return res.json({
        items,
        metadata: {
          source: "api",
          lang,
          updatedAt: saved.updatedAt,
          isFresh: true,
          forceRefresh,
        },
      });
    } catch (error) {
      if (cachePayload && Array.isArray(cachePayload.items)) {
        return res.json({
          items: cachePayload.items,
          metadata: {
            source: "cache",
            lang,
            updatedAt: cachePayload.updatedAt,
            isFresh: false,
            warning: "Catalog API failed. Returned last cached data.",
          },
        });
      }

      return res
        .status(500)
        .json({ message: error.message || "Request failed" });
    }
  });

  app.post("/api/catalogs/refresh", async (req, res) => {
    const lang = req.body?.lang || req.query.lang || "en-US";

    try {
      const items = await fetchCatalogsFromApi(lang);
      const saved = writeCache(lang, items);

      return res.json({
        items,
        metadata: {
          source: "api",
          lang,
          updatedAt: saved.updatedAt,
          isFresh: true,
          forceRefresh: true,
        },
      });
    } catch (error) {
      const cachePayload = readCache(lang);

      if (cachePayload && Array.isArray(cachePayload.items)) {
        return res.json({
          items: cachePayload.items,
          metadata: {
            source: "cache",
            lang,
            updatedAt: cachePayload.updatedAt,
            isFresh: false,
            warning: "Refresh failed. Returned last cached data.",
          },
        });
      }

      return res.status(500).json({
        message: error.message || "Refresh failed",
      });
    }
  });

  app.get("/api/catalog-products", async (req, res) => {
    const catalogVersionId = String(req.query.catalogVersionId || "").trim();
    const lang = String(req.query.lang || "en-US").trim();
    const forceRefresh =
      String(req.query.force || "false").toLowerCase() === "true";

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    const cachePayload = readProductCache(lang, catalogVersionId);
    const hasFreshCache = isCacheFresh(cachePayload);

    if (!forceRefresh && hasFreshCache) {
      return res.json({
        items: cachePayload.items || [],
        metadata: {
          ...(cachePayload.metadata || {}),
          source: "cache",
          lang,
          catalogVersionId,
          updatedAt: cachePayload.updatedAt,
          isFresh: true,
        },
        raw: cachePayload.raw || null,
      });
    }

    try {
      const payload = await fetchProductsByCatalogVersionId(catalogVersionId);
      const { items, path } = extractItemsFromPayload(payload);
      const metadata = {
        catalogVersionId,
        total: items.length,
        itemsPath: path,
        source: "api",
        lang,
        isFresh: true,
        forceRefresh,
      };
      const saved = writeProductCache(lang, catalogVersionId, {
        items,
        metadata,
        raw: payload,
      });

      return res.json({
        items,
        metadata: {
          ...metadata,
          updatedAt: saved.updatedAt,
        },
        raw: payload,
      });
    } catch (error) {
      if (cachePayload) {
        return res.json({
          items: cachePayload.items || [],
          metadata: {
            ...(cachePayload.metadata || {}),
            source: "cache",
            lang,
            catalogVersionId,
            updatedAt: cachePayload.updatedAt,
            isFresh: false,
            warning: "Products API failed. Returned last cached data.",
          },
          raw: cachePayload.raw || null,
        });
      }

      return res.status(500).json({
        message: error.message || "Failed to fetch products.",
      });
    }
  });

  app.post("/api/catalog-products/refresh", async (req, res) => {
    const catalogVersionId = String(
      req.body?.catalogVersionId || req.query.catalogVersionId || "",
    ).trim();
    const lang = String(req.body?.lang || req.query.lang || "en-US").trim();

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    try {
      const payload = await fetchProductsByCatalogVersionId(catalogVersionId);
      const { items, path } = extractItemsFromPayload(payload);
      const metadata = {
        catalogVersionId,
        total: items.length,
        itemsPath: path,
        source: "api",
        lang,
        isFresh: true,
        forceRefresh: true,
      };
      const saved = writeProductCache(lang, catalogVersionId, {
        items,
        metadata,
        raw: payload,
      });

      return res.json({
        items,
        metadata: {
          ...metadata,
          updatedAt: saved.updatedAt,
        },
        raw: payload,
      });
    } catch (error) {
      const cachePayload = readProductCache(lang, catalogVersionId);

      if (cachePayload) {
        return res.json({
          items: cachePayload.items || [],
          metadata: {
            ...(cachePayload.metadata || {}),
            source: "cache",
            lang,
            catalogVersionId,
            updatedAt: cachePayload.updatedAt,
            isFresh: false,
            warning: "Product refresh failed. Returned last cached data.",
          },
          raw: cachePayload.raw || null,
        });
      }

      return res.status(500).json({
        message: error.message || "Failed to refresh products.",
      });
    }
  });

  app.get("/api/catalog-products/refresh", async (req, res) => {
    const catalogVersionId = String(
      req.query.catalogVersionId || req.body?.catalogVersionId || "",
    ).trim();
    const lang = String(req.query.lang || req.body?.lang || "en-US").trim();

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    try {
      const payload = await fetchProductsByCatalogVersionId(catalogVersionId);
      const { items, path } = extractItemsFromPayload(payload);
      const metadata = {
        catalogVersionId,
        total: items.length,
        itemsPath: path,
        source: "api",
        lang,
        isFresh: true,
        forceRefresh: true,
      };
      const saved = writeProductCache(lang, catalogVersionId, {
        items,
        metadata,
        raw: payload,
      });

      return res.json({
        items,
        metadata: {
          ...metadata,
          updatedAt: saved.updatedAt,
        },
        raw: payload,
      });
    } catch (error) {
      const cachePayload = readProductCache(lang, catalogVersionId);

      if (cachePayload) {
        return res.json({
          items: cachePayload.items || [],
          metadata: {
            ...(cachePayload.metadata || {}),
            source: "cache",
            lang,
            catalogVersionId,
            updatedAt: cachePayload.updatedAt,
            isFresh: false,
            warning: "Product refresh failed. Returned last cached data.",
          },
          raw: cachePayload.raw || null,
        });
      }

      return res.status(500).json({
        message: error.message || "Failed to refresh products.",
      });
    }
  });

  app.get("/api/catalog-products/full-details", async (req, res) => {
    const catalogVersionId = String(req.query.catalogVersionId || "").trim();
    const lang = String(req.query.lang || "en-US").trim();
    const forceRefresh =
      String(req.query.force || "false").toLowerCase() === "true";

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    const cachePayload = readFullDetailsCache(lang, catalogVersionId);
    const currentJob = getFullDetailsJobStatus(lang, catalogVersionId);

    if (
      !forceRefresh &&
      isCacheFresh(cachePayload) &&
      Array.isArray(cachePayload?.fullDetails)
    ) {
      return res.json({
        status: "ready",
        preview: buildFullDetailsPreview(cachePayload.fullDetails),
        metadata: {
          ...buildFullDetailsMetadata(
            cachePayload.metadata,
            cachePayload.fullDetails,
            {
              source: "cache",
              lang,
              catalogVersionId,
              updatedAt: cachePayload.updatedAt,
              isFresh: true,
              status: "ready",
              logs: Array.isArray(currentJob?.logs) ? currentJob.logs : [],
            },
          ),
        },
      });
    }

    if (currentJob?.status === "running") {
      return res.status(202).json({
        status: "running",
        metadata: buildFullDetailsJobMetadata(
          lang,
          catalogVersionId,
          currentJob,
        ),
        preview: [],
        message: "Full details cache is still generating.",
      });
    }

    if (!forceRefresh && currentJob?.status === "failed") {
      return res.status(500).json({
        status: "failed",
        metadata: buildFullDetailsJobMetadata(
          lang,
          catalogVersionId,
          currentJob,
        ),
        preview: [],
        message:
          currentJob.error ||
          "Full details cache generation failed and will not continue.",
      });
    }

    try {
      const result = await ensureFullDetailsCache(
        catalogVersionId,
        lang,
        forceRefresh,
      );

      if (result.status === "ready" && result.cachePayload) {
        return res.json({
          status: "ready",
          preview: buildFullDetailsPreview(result.cachePayload.fullDetails),
          metadata: {
            ...buildFullDetailsMetadata(
              result.cachePayload.metadata,
              result.cachePayload.fullDetails,
              {
                source: "cache",
                lang,
                catalogVersionId,
                updatedAt: result.cachePayload.updatedAt,
                isFresh: true,
                status: "ready",
              },
            ),
          },
        });
      }

      if (result.status === "failed") {
        const failedJob =
          result.job || getFullDetailsJobStatus(lang, catalogVersionId);
        return res.status(500).json({
          status: "failed",
          metadata: buildFullDetailsJobMetadata(
            lang,
            catalogVersionId,
            failedJob,
          ),
          preview: [],
          message:
            failedJob?.error ||
            "Full details cache generation failed and will not continue.",
        });
      }

      const job = getFullDetailsJobStatus(lang, catalogVersionId);
      return res.status(202).json({
        status: job?.status || "running",
        metadata: buildFullDetailsJobMetadata(lang, catalogVersionId, job),
        preview: [],
        message: result.started
          ? "Started generating full details cache."
          : "Full details cache is still generating.",
      });
    } catch (error) {
      if (cachePayload && Array.isArray(cachePayload.fullDetails)) {
        return res.json({
          status: "ready",
          preview: buildFullDetailsPreview(cachePayload.fullDetails),
          metadata: {
            ...buildFullDetailsMetadata(
              cachePayload.metadata,
              cachePayload.fullDetails,
              {
                source: "cache",
                lang,
                catalogVersionId,
                updatedAt: cachePayload.updatedAt,
                isFresh: false,
                status: "ready",
                warning: "Full details API failed. Returned last cached data.",
              },
            ),
          },
        });
      }

      return res.status(500).json({
        message: error.message || "Failed to fetch product full details.",
      });
    }
  });

  app.get("/api/catalog-products/full-details/content", (req, res) => {
    const catalogVersionId = String(req.query.catalogVersionId || "").trim();
    const lang = String(req.query.lang || "en-US").trim();
    const download =
      String(req.query.download || "false").toLowerCase() === "true";
    const cachePayload = readFullDetailsCache(lang, catalogVersionId);

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    if (!cachePayload || !Array.isArray(cachePayload.fullDetails)) {
      const job = getFullDetailsJobStatus(lang, catalogVersionId);
      return res.status(409).json({
        metadata: job
          ? {
              catalogVersionId,
              lang,
              status: job.status,
              startedAt: job.startedAt,
              updatedAt: job.updatedAt,
              completed: job.completed || 0,
              total: job.total || 0,
              logs: Array.isArray(job.logs) ? job.logs : [],
            }
          : null,
        message:
          job?.status === "running"
            ? "Full details cache is still generating."
            : "Full details cache is not ready yet.",
      });
    }

    if (download) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(
          fullDetailsCacheFilePath(lang, catalogVersionId),
        )}"`,
      );
    }

    return res.json({
      fullDetails: cachePayload.fullDetails,
      metadata: {
        ...buildFullDetailsMetadata(
          cachePayload.metadata,
          cachePayload.fullDetails,
          {
            source: "cache",
            lang,
            catalogVersionId,
            updatedAt: cachePayload.updatedAt,
            isFresh: isCacheFresh(cachePayload),
            status: "ready",
          },
        ),
      },
    });
  });

  app.get("/api/catalog-products/generated-files", (req, res) => {
    const catalogVersionId = String(req.query.catalogVersionId || "").trim();
    const lang = String(req.query.lang || "en-US").trim();

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    try {
      const catalog = findCatalogByVersionId(
        getCatalogItemsFromCache(lang),
        catalogVersionId,
      );
      const siteCode = String(catalog?.code || "").trim();
      const catalogName = getCatalogNameByVersionId(lang, catalogVersionId);
      const fullDetailsPath = fullDetailsCacheFilePath(lang, catalogVersionId);
      const fullDetailsMetadata = buildFileMetadata(fullDetailsPath);
      const catalogDir = generatedCatalogDirPath(catalogName);
      normalizeGeneratedFiles(catalogDir);
      const productTypeFiles = listJsonFiles(catalogDir)
        .filter((fileName) => isGeneratedProductTypeFile(fileName))
        .map((fileName) => {
          const productType = readGeneratedProductTypeName(fileName);
          const filePath = path.join(catalogDir, fileName);
          const fileMetadata = buildFileMetadata(filePath);

          return {
            type: "productType",
            productType,
            title: productType
              .split(/[_-]+/)
              .filter(Boolean)
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join(" "),
            ...fileMetadata,
            downloadUrl: siteCode
              ? `/api/download-file?siteCode=${encodeURIComponent(
                  siteCode,
                )}&fileName=${encodeURIComponent(
                  fileName,
                )}&lang=${encodeURIComponent(lang)}`
              : `/api/refresh-all/${encodeURIComponent(
                  catalogVersionId,
                )}/types/${encodeURIComponent(
                  productType,
                )}?lang=${encodeURIComponent(lang)}&download=true`,
          };
        });

      return res.json({
        catalogVersionId,
        lang,
        catalogName,
        fullDetails: fullDetailsMetadata
          ? {
              type: "fullDetails",
              title: "Full Details JSON",
              ...fullDetailsMetadata,
              downloadUrl: `/api/catalog-products/full-details/content?catalogVersionId=${encodeURIComponent(
                catalogVersionId,
              )}&lang=${encodeURIComponent(lang)}&download=true`,
            }
          : null,
        productTypeFiles,
        totalProductTypeFiles: productTypeFiles.length,
      });
    } catch (error) {
      return res.status(500).json({
        message: error.message || "Failed to list generated files.",
      });
    }
  });

  app.get("/api/download-file", (req, res) => {
    const siteCode = String(req.query.siteCode || req.query.code || "").trim();
    const fileNameParam = String(req.query.fileName || "").trim();
    const lang = String(req.query.lang || "en-US").trim();

    if (!siteCode) {
      return res.status(400).json({
        message: "siteCode query parameter is required.",
      });
    }

    if (!fileNameParam) {
      return res.status(400).json({
        message: "fileName query parameter is required.",
      });
    }

    try {
      const catalog = findCatalogBySiteCode(lang, siteCode);

      if (!catalog) {
        return res.status(404).json({
          message: `Catalog with site code '${siteCode}' not found.`,
        });
      }

      const catalogName = catalog.name || catalog.title || "unknown";
      const catalogDir = generatedCatalogDirPath(catalogName);

      if (!fs.existsSync(catalogDir)) {
        return res.status(404).json({
          message: `Generated files are not available for site code '${siteCode}'.`,
          catalogName,
        });
      }

      const requestedFileName = sanitizeFileSegment(fileNameParam, "");
      const requestedBaseName = path.basename(requestedFileName, ".json");
      const isAllFiles = requestedBaseName.toLowerCase() === "all";

      if (isAllFiles) {
        const files = listJsonFiles(catalogDir)
          .filter((fileName) => isGeneratedProductTypeFile(fileName))
          .map((fileName) => ({
            name: fileName,
            path: path.join(catalogDir, fileName),
          }))
          .filter((file) => isPathInside(catalogDir, file.path));

        if (!files.length) {
          return res.status(404).json({
            message: `No product type files are available for site code '${siteCode}'.`,
            catalogName,
          });
        }

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${sanitizeFileSegment(siteCode)}-product-types.zip"`,
        );
        res.setHeader("Content-Type", "application/zip");
        return writeZipFileToResponse(res, files);
      }

      const fileName = requestedFileName.toLowerCase().endsWith(".json")
        ? requestedFileName
        : `${requestedFileName}.json`;
      let filePath = path.join(catalogDir, fileName);

      if (!isPathInside(catalogDir, filePath) || !fs.existsSync(filePath)) {
        const requestedType = readGeneratedProductTypeName(fileName);
        const normalizedFileName =
          buildGeneratedProductTypeFileName(requestedType);
        const normalizedFilePath = path.join(catalogDir, normalizedFileName);

        if (
          isPathInside(catalogDir, normalizedFilePath) &&
          fs.existsSync(normalizedFilePath)
        ) {
          filePath = normalizedFilePath;
        }
      }

      if (!isPathInside(catalogDir, filePath) || !fs.existsSync(filePath)) {
        return res.status(404).json({
          message: `File '${fileNameParam}' not found for site code '${siteCode}'.`,
          availableFiles: listJsonFiles(catalogDir),
        });
      }

      return streamJsonFileDownload(
        req,
        res,
        filePath,
        path.basename(filePath),
      );
    } catch (error) {
      return res.status(500).json({
        message: error.message || "Failed to download file.",
      });
    }
  });

  app.get("/api/catalog-products/full-details/status", (req, res) => {
    const catalogVersionId = String(req.query.catalogVersionId || "").trim();
    const lang = String(req.query.lang || "en-US").trim();

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    const cachePayload = readFullDetailsCache(lang, catalogVersionId);
    const job = getFullDetailsJobStatus(lang, catalogVersionId);
    const hasCache = Boolean(
      cachePayload && Array.isArray(cachePayload.fullDetails),
    );

    return res.json({
      hasCache,
      status: hasCache ? "ready" : job?.status || "missing",
      metadata: hasCache
        ? buildFullDetailsMetadata(
            cachePayload.metadata,
            cachePayload.fullDetails,
            {
              source: "cache",
              lang,
              catalogVersionId,
              updatedAt: cachePayload.updatedAt,
              isFresh: isCacheFresh(cachePayload),
              status: "ready",
            },
          )
        : job
          ? buildFullDetailsJobMetadata(lang, catalogVersionId, job)
          : {
              catalogVersionId,
              lang,
              status: "missing",
              fullDetailsTotal: 0,
              cacheFile: path.basename(
                fullDetailsCacheFilePath(lang, catalogVersionId),
              ),
            },
    });
  });

  app.post("/api/catalog-products/clear-site-cache", (req, res) => {
    const catalogVersionId = String(
      req.body?.catalogVersionId || req.query.catalogVersionId || "",
    ).trim();
    const lang = String(req.body?.lang || req.query.lang || "en-US").trim();

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    const catalogs = getCatalogItemsFromCache(lang);
    const catalog = findCatalogByVersionId(catalogs, catalogVersionId);

    if (!catalog) {
      return res.status(404).json({
        message: "Catalog was not found in the local catalog cache.",
      });
    }

    const catalogName =
      catalog?.name || catalog?.title || `catalog-${catalogVersionId}`;
    const retailerCode = String(catalog?.code || "").trim();
    const versionIds = Array.isArray(catalog.catalogVersions)
      ? catalog.catalogVersions
          .map((version) => version?.id)
          .filter((versionId) => versionId !== undefined && versionId !== null)
          .map(String)
      : [catalogVersionId];
    const removed = [];
    const missing = [];
    const skipped = [];

    function track(label, cleanup) {
      try {
        const removedValue =
          typeof cleanup === "function" ? cleanup() : Boolean(cleanup);
        (removedValue ? removed : missing).push(label);
      } catch (error) {
        skipped.push({
          label,
          error: error.message || String(error),
        });
        console.warn("Skipping cache cleanup after error.", {
          label,
          error: error.message || String(error),
        });
      }
    }

    function runSiteCacheCleanup() {
      for (const versionId of versionIds) {
        track(`products-${lang}-${versionId}`, () =>
          deleteProductCache(lang, versionId),
        );
        track(`full-details-${lang}-${versionId}`, () =>
          deleteFullDetailsCache(lang, versionId),
        );
        track(`item-details-${lang}-${versionId}`, () =>
          deleteItemDetailsCache(lang, versionId),
        );
        clearFullDetailsJobStatus(lang, versionId);
        productTypeExportJobs.delete(
          getProductTypeExportJobKey(lang, versionId),
        );
        unregisterActiveJob(getFullDetailsJobKey(lang, versionId));
      }

      if (retailerCode) {
        const dependencyFilePath = catalogDependencyCacheFilePath(
          retailerCode,
          catalogName,
        );
        const dependencyDirPath = path.dirname(dependencyFilePath);
        const dependenciesRoot = path.join(cacheDir, "dependencies");
        if (isPathInside(dependenciesRoot, dependencyDirPath)) {
          track(`dependencies-${catalogName}`, () =>
            deleteDirectoryIfExists(dependencyDirPath),
          );
        }
      }

      const generatedDirPath = generatedCatalogDirPath(catalogName);
      if (isPathInside(generatedDir, generatedDirPath)) {
        track(`generated-${catalogName}`, () =>
          deleteDirectoryIfExists(generatedDirPath),
        );
      }

      itemDetailsMemoCache.clear();
      itemDetailsRequestQueue.clear();

      console.log("Site cache cleanup completed.", {
        catalogVersionId,
        catalogName,
        removed,
        missing,
        skipped,
      });
    }

    setTimeout(() => {
      try {
        runSiteCacheCleanup();
      } catch (error) {
        console.error("Site cache cleanup failed after response.", {
          catalogVersionId,
          catalogName,
          error: error.message || String(error),
        });
      }
    }, 100);

    return res.status(202).json({
      status: "clearing",
      message: "Site cache cleanup started.",
      catalogVersionId,
      catalogName,
      versionIds,
      removed,
      missing,
      skipped,
    });
  });

  app.post("/api/catalog-products/export-by-type", (req, res) => {
    console.log("POST /api/catalog-products/export-by-type", {
      catalogVersionId:
        req.body?.catalogVersionId || req.query.catalogVersionId,
      lang: req.body?.lang || req.query.lang,
      bodyType: typeof req.body,
    });

    const catalogVersionId = String(
      req.body?.catalogVersionId || req.query.catalogVersionId || "",
    ).trim();
    const lang = String(req.body?.lang || req.query.lang || "en-US").trim();
    const forceRegenerate =
      String(req.body?.force || req.query.force || "false").toLowerCase() ===
      "true";
    const cachePayload = readFullDetailsCache(lang, catalogVersionId);

    if (!catalogVersionId) {
      return res.status(400).json({
        message: "catalogVersionId is required.",
      });
    }

    if (!cachePayload || !Array.isArray(cachePayload.fullDetails)) {
      const job = getFullDetailsJobStatus(lang, catalogVersionId);
      return res.status(409).json({
        metadata: job
          ? {
              catalogVersionId,
              lang,
              status: job.status,
              startedAt: job.startedAt,
              updatedAt: job.updatedAt,
              completed: job.completed || 0,
              total: job.total || 0,
              logs: Array.isArray(job.logs) ? job.logs : [],
            }
          : null,
        message:
          job?.status === "running"
            ? "Full details cache is still generating."
            : "Full details cache is not ready yet.",
      });
    }

    const catalogName = getCatalogNameByVersionId(lang, catalogVersionId);
    const generatedFilesExist =
      listJsonFiles(generatedCatalogDirPath(catalogName)).length > 0;
    const existingJob = getProductTypeExportJobStatus(lang, catalogVersionId);
    const jobMatchesCache =
      existingJob?.result &&
      existingJob.result.totalProducts === cachePayload.fullDetails.length &&
      existingJob.result.catalogName === catalogName;

    if (
      !forceRegenerate &&
      existingJob?.status === "ready" &&
      generatedFilesExist &&
      jobMatchesCache
    ) {
      return res.json(
        buildProductTypeExportResponse(
          existingJob,
          cachePayload,
          lang,
          catalogVersionId,
        ),
      );
    }

    if (existingJob?.status === "failed") {
      return res
        .status(500)
        .json(
          buildProductTypeExportResponse(
            existingJob,
            cachePayload,
            lang,
            catalogVersionId,
          ),
        );
    }

    try {
      const result = buildProductTypeExports(
        cachePayload.fullDetails,
        lang,
        catalogVersionId,
      );
      console.log("Product JSON export completed.", {
        catalogVersionId,
        lang,
        totalFiles: result.totalFiles,
        totalProducts: result.totalProducts,
      });
      const completedJob = {
        status: "ready",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        total: cachePayload.fullDetails.length,
        error: "",
        result,
      };
      setProductTypeExportJobStatus(lang, catalogVersionId, completedJob);

      return res.json(
        buildProductTypeExportResponse(
          getProductTypeExportJobStatus(lang, catalogVersionId),
          cachePayload,
          lang,
          catalogVersionId,
        ),
      );
    } catch (error) {
      console.error("Product JSON export failed.", {
        catalogVersionId,
        lang,
        error: error?.stack || error?.message || error,
      });
      const failedJob = {
        status: "failed",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        total: cachePayload.fullDetails.length,
        error: error.message || "Failed to generate product JSON files.",
        result: null,
      };
      setProductTypeExportJobStatus(lang, catalogVersionId, failedJob);

      return res
        .status(500)
        .json(
          buildProductTypeExportResponse(
            getProductTypeExportJobStatus(lang, catalogVersionId),
            cachePayload,
            lang,
            catalogVersionId,
          ),
        );
    }
  });

  app.get("/api/refresh-all/:catalogId", async (req, res) => {
    const catalogId = req.params.catalogId;
    const lang = req.query.lang || "en-US";
    const download =
      String(req.query.download || "false").toLowerCase() === "true";
    const forceRefresh =
      String(req.query.forceRefresh || "false").toLowerCase() === "true";

    if (!catalogId) {
      return res.status(400).json({
        message: "catalogId is required.",
      });
    }

    try {
      let productsData, fullDetailsData;

      // Handle products
      const existingProductCache = readProductCache(lang, catalogId);
      const hasFreshProductCache =
        existingProductCache && isCacheFresh(existingProductCache);

      if (!forceRefresh && hasFreshProductCache) {
        productsData = {
          items: existingProductCache.items || [],
          metadata: {
            ...(existingProductCache.metadata || {}),
            source: "cache",
            lang,
            catalogVersionId: catalogId,
            updatedAt: existingProductCache.updatedAt,
            isFresh: true,
          },
          raw: existingProductCache.raw || null,
        };
      } else {
        // Refresh products
        const productsPayload =
          await fetchProductsByCatalogVersionId(catalogId);
        const { items: products, path: productsPath } =
          extractItemsFromPayload(productsPayload);
        const productsMetadata = {
          catalogVersionId: catalogId,
          total: products.length,
          itemsPath: productsPath,
          source: "api",
          lang,
          isFresh: true,
          forceRefresh,
        };
        const savedProducts = writeProductCache(lang, catalogId, {
          items: products,
          metadata: productsMetadata,
          raw: productsPayload,
        });
        productsData = {
          items: products,
          metadata: {
            ...productsMetadata,
            updatedAt: savedProducts.updatedAt,
          },
          raw: productsPayload,
        };
      }

      // Handle full details
      const existingFullDetailsCache = readFullDetailsCache(lang, catalogId);
      const hasFreshFullDetailsCache =
        existingFullDetailsCache && isCacheFresh(existingFullDetailsCache);

      if (!forceRefresh && hasFreshFullDetailsCache) {
        fullDetailsData = {
          fullDetails: existingFullDetailsCache.fullDetails,
          metadata: {
            ...buildFullDetailsMetadata(
              existingFullDetailsCache.metadata,
              existingFullDetailsCache.fullDetails,
              {
                source: "cache",
                lang,
                catalogVersionId: catalogId,
                updatedAt: existingFullDetailsCache.updatedAt,
                isFresh: true,
                status: "ready",
              },
            ),
          },
        };
      } else {
        const fullDetailsResult = await ensureFullDetailsCache(
          catalogId,
          lang,
          forceRefresh,
        );
        const fullDetailsCache =
          fullDetailsResult.cachePayload ||
          readFullDetailsCache(lang, catalogId);

        fullDetailsData = fullDetailsCache
          ? {
              fullDetails: fullDetailsCache.fullDetails,
              metadata: {
                ...buildFullDetailsMetadata(
                  fullDetailsCache.metadata,
                  fullDetailsCache.fullDetails,
                  {
                    source: "cache",
                    lang,
                    catalogVersionId: catalogId,
                    updatedAt: fullDetailsCache.updatedAt,
                    isFresh: true,
                    status: "ready",
                  },
                ),
              },
            }
          : null;

        if (fullDetailsResult.status !== "ready" && !fullDetailsData) {
          const job = getFullDetailsJobStatus(lang, catalogId);
          return res.status(202).json({
            status: job?.status || "running",
            catalogId,
            lang,
            refreshedAt: new Date().toISOString(),
            forceRefresh,
            products: productsData,
            fullDetails: null,
            generated: {},
            metadata: {
              catalogVersionId: catalogId,
              lang,
              status: job?.status || "running",
              startedAt: job?.startedAt || new Date().toISOString(),
              updatedAt: job?.updatedAt || new Date().toISOString(),
              completed: job?.completed || 0,
              total: job?.total || 0,
              progressPercent:
                job?.total > 0
                  ? Math.round((job.completed / job.total) * 100)
                  : 0,
            },
            message: fullDetailsResult.started
              ? "Started generating full details cache."
              : "Full details cache is still generating.",
          });
        }
      }

      const catalogName = getGeneratedCatalogName(lang, catalogId);
      const generatedDirPath = generatedCatalogDirPath(catalogName);
      normalizeGeneratedFiles(generatedDirPath);
      const generatedProductTypeFiles = listJsonFiles(generatedDirPath).filter(
        (fileName) => isGeneratedProductTypeFile(fileName),
      );
      const shouldGenerateFiles =
        Array.isArray(fullDetailsData?.fullDetails) &&
        (forceRefresh || generatedProductTypeFiles.length === 0);

      if (shouldGenerateFiles) {
        buildProductTypeExports(fullDetailsData.fullDetails, lang, catalogId);
      }

      const generatedFiles = readGeneratedProductTypeFiles(
        catalogName,
        catalogId,
      ).types;

      // Return all data
      const responseData = {
        catalogId,
        lang,
        refreshedAt: new Date().toISOString(),
        forceRefresh,
        products: productsData,
        fullDetails: fullDetailsData,
        generated: generatedFiles,
      };

      if (download) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="catalog-${catalogId}-all-data.json"`,
        );
      }

      res.json(responseData);
    } catch (error) {
      return res.status(500).json({
        message: error.message || "Failed to refresh and fetch data.",
      });
    }
  });

  app.get("/api/refresh-all/:catalogId/types", async (req, res) => {
    const catalogId = req.params.catalogId;
    const lang = req.query.lang || "en-US";
    const format = (req.query.format || "json").toLowerCase();

    try {
      const catalogName = getGeneratedCatalogName(lang, catalogId);
      const { types, availableTypes } = readGeneratedProductTypeFiles(
        catalogName,
        catalogId,
      );

      if (format === "list") {
        return res.json({
          catalogId,
          lang,
          availableTypes,
          totalTypes: availableTypes.length,
        });
      }

      res.json({
        catalogId,
        lang,
        types,
        availableTypes,
      });
    } catch (error) {
      return res.status(500).json({
        message: error.message || "Failed to fetch product types.",
      });
    }
  });

  app.get(
    "/api/refresh-all/:catalogId/types/:productType",
    async (req, res) => {
      const catalogId = req.params.catalogId;
      const productType = req.params.productType;
      const lang = req.query.lang || "en-US";
      const download =
        String(req.query.download || "true").toLowerCase() === "true";

      if (!productType) {
        return res.status(400).json({
          message: "productType is required.",
        });
      }

      try {
        const generatedDirPath = generatedCatalogDirPath(
          getGeneratedCatalogName(lang, catalogId),
        );
        const fileName = `cic_${sanitizeFileSegment(productType, "unknown")}.json`;
        const filePath = path.join(generatedDirPath, fileName);

        if (!fs.existsSync(filePath)) {
          return res.status(404).json({
            message: `Product type "${productType}" not found.`,
            availableAt: `/api/refresh-all/${catalogId}/types?format=list`,
          });
        }

        const parsed = readJsonFile(filePath);
        if (!parsed) {
          return res.status(404).json({
            message: `Product type "${productType}" not found.`,
            availableAt: `/api/refresh-all/${catalogId}/types?format=list`,
          });
        }

        if (download) {
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`,
          );
        }

        res.setHeader("Content-Type", "application/json");
        res.json(parsed);
      } catch (error) {
        return res.status(500).json({
          message: error.message || `Failed to fetch ${productType} data.`,
        });
      }
    },
  );

  app.get("/api/company-products", async (req, res) => {
    const companyCode = String(req.query.code || "").trim();
    const lang = String(req.query.lang || "en-US").trim();
    const forceRegenerate =
      String(req.query.force || "false").toLowerCase() === "true";

    if (!companyCode) {
      return res.status(400).json({
        message: "code parameter is required (company code from catalog)",
      });
    }

    try {
      // Step 1: Get all catalogs
      let catalogs = readCache(lang);
      if (!catalogs || !Array.isArray(catalogs.items)) {
        catalogs = await fetchCatalogsFromApi(lang);
        writeCache(lang, catalogs);
      }

      // Step 2: Find catalog by code
      const catalog = Array.isArray(catalogs.items)
        ? catalogs.items.find((c) => String(c.code || "") === companyCode)
        : null;

      if (!catalog) {
        return res.status(404).json({
          message: `Catalog with code '${companyCode}' not found.`,
        });
      }

      const catalogVersionId = catalog.catalogVersionId || catalog.id;
      const catalogName = catalog.name || "unknown";

      if (!catalogVersionId) {
        return res.status(400).json({
          message: `Catalog with code '${companyCode}' has no catalogVersionId.`,
        });
      }

      // Step 3: Check if we need to regenerate or use cache
      const fullDetailsCache = readFullDetailsCache(lang, catalogVersionId);
      const productsCache = readProductCache(lang, catalogVersionId);
      const generatedDir = path.join(
        cacheDir,
        "generated",
        sanitizeFileSegment(catalogName),
      );
      const generatedFilesExist =
        fs.existsSync(generatedDir) &&
        fs.readdirSync(generatedDir).some((f) => f.endsWith(".json"));

      const filesReady =
        fullDetailsCache &&
        Array.isArray(fullDetailsCache.fullDetails) &&
        productsCache &&
        Array.isArray(productsCache.items) &&
        generatedFilesExist;

      if (!forceRegenerate && filesReady) {
        // Return cached files
        const files = fs
          .readdirSync(generatedDir)
          .filter((f) => f.endsWith(".json"));

        return res.json({
          status: "ready",
          source: "cache",
          companyCode,
          catalogVersionId,
          catalogName,
          fullDetails: {
            total: fullDetailsCache.fullDetails.length,
            file: path.basename(
              fullDetailsCacheFilePath(lang, catalogVersionId),
            ),
            cached: true,
          },
          products: {
            total: productsCache.items.length,
            file: path.basename(productCacheFilePath(lang, catalogVersionId)),
            cached: true,
          },
          productTypes: {
            total: files.length,
            files: files,
            directory: sanitizeFileSegment(catalogName),
          },
          metadata: {
            lang,
            generatedAt: fullDetailsCache.updatedAt,
            productsUpdatedAt: productsCache.updatedAt,
          },
        });
      }

      // Step 4: Need to generate/regenerate - start full details job
      const generateFullDetails =
        !fullDetailsCache ||
        !Array.isArray(fullDetailsCache.fullDetails) ||
        forceRegenerate;
      const generateProducts =
        !productsCache ||
        !Array.isArray(productsCache.items) ||
        forceRegenerate;

      const result = await ensureFullDetailsCache(
        catalogVersionId,
        lang,
        generateFullDetails || generateProducts,
      );

      // Step 5: Wait for job to start and return status
      const currentJob = getFullDetailsJobStatus(lang, catalogVersionId);

      if (currentJob?.status === "running" || result.started) {
        return res.status(202).json({
          status: "generating",
          source: "job",
          companyCode,
          catalogVersionId,
          catalogName,
          metadata: {
            lang,
            status: currentJob?.status || "running",
            startedAt: currentJob?.startedAt || new Date().toISOString(),
            completed: currentJob?.completed || 0,
            total: currentJob?.total || 0,
            progressPercent:
              currentJob?.total > 0
                ? Math.round((currentJob.completed / currentJob.total) * 100)
                : 0,
          },
          message: "Generation job has started. Check back later for results.",
        });
      }

      const finalFullDetails = readFullDetailsCache(lang, catalogVersionId);
      const finalProducts = readProductCache(lang, catalogVersionId);
      const finalFiles = listJsonFiles(generatedDir);

      if (
        finalFullDetails &&
        Array.isArray(finalFullDetails.fullDetails) &&
        !finalFiles.length
      ) {
        const exportResult = startProductTypeExportJob(
          finalFullDetails.fullDetails,
          lang,
          catalogVersionId,
        );
        const exportJob =
          getProductTypeExportJobStatus(lang, catalogVersionId) ||
          exportResult.job;

        return res.status(202).json({
          status: "exporting",
          source: "job",
          companyCode,
          catalogVersionId,
          catalogName,
          metadata: {
            lang,
            status: exportJob?.status || "running",
            startedAt: exportJob?.startedAt || new Date().toISOString(),
            updatedAt: exportJob?.updatedAt || new Date().toISOString(),
            total: exportJob?.total || 0,
          },
          message: "Product type export job has started.",
        });
      }

      return res.json({
        status: "ready",
        source: "generated",
        companyCode,
        catalogVersionId,
        catalogName,
        fullDetails: {
          total: finalFullDetails?.fullDetails?.length || 0,
          file: path.basename(fullDetailsCacheFilePath(lang, catalogVersionId)),
          cached: true,
        },
        products: {
          total: finalProducts?.items?.length || 0,
          file: path.basename(productCacheFilePath(lang, catalogVersionId)),
          cached: true,
        },
        productTypes: {
          total: finalFiles.length,
          files: finalFiles,
          directory: sanitizeFileSegment(catalogName),
        },
        metadata: {
          lang,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return res.status(500).json({
        message: error.message || "Failed to process company products.",
      });
    }
  });
};

module.exports = { registerApiRoutes };
