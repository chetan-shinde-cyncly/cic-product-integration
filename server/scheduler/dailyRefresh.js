const createDailyRefreshScheduler = (app, dependencies = {}) => {
  const {
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
    requireAuth = (_req, _res, next) => next(),
  } = dependencies;

  const DAILY_REFRESH_IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const DAILY_REFRESH_HOUR_IST = Number(
    process.env.DAILY_REFRESH_HOUR_IST || 6,
  );
  const DAILY_REFRESH_MINUTE_IST = Number(
    process.env.DAILY_REFRESH_MINUTE_IST || 0,
  );
  const DAILY_REFRESH_LANG = process.env.DAILY_REFRESH_LANG || "en-US";
  const DAILY_REFRESH_SPACING_MINUTES = Number(
    process.env.DAILY_REFRESH_SPACING_MINUTES || 3,
  );
  const DAILY_REFRESH_ENABLED =
    String(process.env.DAILY_REFRESH_ENABLED || "true").toLowerCase() !==
    "false";
  const DEFAULT_DAILY_REFRESH_CATALOG_VERSION_IDS = ["19947"];
  let dailyRefreshRunning = false;
  let dailyRefreshTimer = null;
  let lastDailyRefreshRun = null;
  let currentDailyRefreshRun = null;
  let nextDailyRefreshRunAt = null;

  function normalizeId(value) {
    return String(value || "").trim();
  }

  function getDurationMs(startedAt, completedAt = new Date().toISOString()) {
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(completedAt).getTime();

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return null;
    }

    return Math.max(0, endMs - startMs);
  }

  function getDailyRefreshCatalogVersionIds() {
    const configured = String(
      process.env.DAILY_REFRESH_CATALOG_VERSION_IDS ||
        process.env.SCHEDULED_REFRESH_CATALOG_VERSION_IDS ||
        "",
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    return configured.length
      ? configured
      : DEFAULT_DAILY_REFRESH_CATALOG_VERSION_IDS;
  }

  function getLatestCatalogVersionId(catalog) {
    if (!catalog || !Array.isArray(catalog.catalogVersions)) {
      return "";
    }

    const sortedVersionIds = catalog.catalogVersions
      .map((version) => version?.id)
      .filter((versionId) => versionId !== undefined && versionId !== null)
      .sort((left, right) => {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        const leftIsNumber = Number.isFinite(leftNumber);
        const rightIsNumber = Number.isFinite(rightNumber);

        if (leftIsNumber && rightIsNumber) {
          return rightNumber - leftNumber;
        }

        return String(right).localeCompare(String(left), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });

    return sortedVersionIds[0] ? String(sortedVersionIds[0]) : "";
  }

  async function readDailyRefreshSelection(lang = DAILY_REFRESH_LANG) {
    let selections = await catalogSelectionRepository.listDailyRefresh(lang);
    if (!selections.length && dailyRefreshSelectionFilePath) {
      const legacy = readJsonFile(dailyRefreshSelectionFilePath());
      const legacyIds = Array.isArray(legacy?.selectedCatalogIds)
        ? legacy.selectedCatalogIds.map(normalizeId).filter(Boolean)
        : [];
      if (legacyIds.length) {
        selections = await catalogSelectionRepository.replaceDailyRefresh(
          legacyIds.map((catalogId) => ({
            catalogId,
            versionStrategy: "LATEST",
          })),
          lang,
        );
        console.log(
          "Migrated daily refresh selections from JSON to PostgreSQL.",
        );
      }
    }
    return {
      lang,
      selections,
      selectedCatalogIds: selections.map((selection) => selection.catalogId),
      updatedAt:
        selections
          .map((selection) => selection.updatedAt)
          .filter(Boolean)
          .sort()
          .at(-1) || "",
    };
  }

  async function writeDailyRefreshSelection(
    selections,
    lang = DAILY_REFRESH_LANG,
  ) {
    const normalized = Array.from(
      new Map(
        (selections || [])
          .map((selection) => {
            const item =
              typeof selection === "object"
                ? selection
                : { catalogId: selection };
            const catalogId = normalizeId(item.catalogId);
            const strategy =
              item.versionStrategy === "PINNED" ? "PINNED" : "LATEST";
            return [
              catalogId,
              {
                ...item,
                catalogId,
                versionStrategy: strategy,
                catalogVersionId:
                  strategy === "PINNED"
                    ? normalizeId(item.catalogVersionId)
                    : null,
              },
            ];
          })
          .filter(
            ([catalogId, item]) =>
              catalogId &&
              (item.versionStrategy !== "PINNED" || item.catalogVersionId),
          ),
      ).values(),
    );
    const saved = await catalogSelectionRepository.replaceDailyRefresh(
      normalized,
      lang,
    );
    return {
      lang,
      selections: saved,
      selectedCatalogIds: saved.map((item) => item.catalogId),
      updatedAt: new Date().toISOString(),
    };
  }

  async function buildDailyRefreshCatalogs(lang = DAILY_REFRESH_LANG) {
    const selected = await readDailyRefreshSelection(lang);
    const selectedCatalogIdSet = new Set(selected.selectedCatalogIds);
    const selectionByCatalogId = new Map(
      selected.selections.map((item) => [item.catalogId, item]),
    );
    const catalogs =
      typeof getCatalogItemsFromCache === "function"
        ? getCatalogItemsFromCache(lang)
        : [];

    return catalogs
      .map((catalog) => {
        const latestVersionId = getLatestCatalogVersionId(catalog);

        const storedSelection = selectionByCatalogId.get(
          normalizeId(catalog?.id),
        );
        return {
          id: normalizeId(catalog?.id),
          code: normalizeId(catalog?.code),
          name: catalog?.name || catalog?.title || "Unnamed catalog",
          selected: selectedCatalogIdSet.has(normalizeId(catalog?.id)),
          latestVersionId,
          selectedVersionId: storedSelection?.catalogVersionId || "",
          versionStrategy: storedSelection?.versionStrategy || "LATEST",
          versionCount: Array.isArray(catalog?.catalogVersions)
            ? catalog.catalogVersions.length
            : 0,
        };
      })
      .filter((catalog) => catalog.id);
  }

  async function resolveCatalogVersionIds(options = {}) {
    const lang = options.lang || DAILY_REFRESH_LANG;
    const explicitIds = Array.isArray(options.catalogVersionIds)
      ? options.catalogVersionIds.map(normalizeId).filter(Boolean)
      : [];

    if (explicitIds.length) {
      return Array.from(new Set(explicitIds));
    }

    const selectedLatestVersionIds = (await buildDailyRefreshCatalogs(lang))
      .filter((catalog) => catalog.selected && catalog.latestVersionId)
      .map((catalog) =>
        catalog.versionStrategy === "PINNED" && catalog.selectedVersionId
          ? catalog.selectedVersionId
          : catalog.latestVersionId,
      );

    if (selectedLatestVersionIds.length) {
      return Array.from(new Set(selectedLatestVersionIds));
    }

    return getDailyRefreshCatalogVersionIds();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getNextIstRunDate(fromDate = new Date()) {
    const nowIstMs = fromDate.getTime() + DAILY_REFRESH_IST_OFFSET_MS;
    const nowIst = new Date(nowIstMs);
    const targetIstMs = Date.UTC(
      nowIst.getUTCFullYear(),
      nowIst.getUTCMonth(),
      nowIst.getUTCDate(),
      DAILY_REFRESH_HOUR_IST,
      DAILY_REFRESH_MINUTE_IST,
      0,
      0,
    );
    const nextTargetIstMs =
      targetIstMs > nowIstMs ? targetIstMs : targetIstMs + 24 * 60 * 60 * 1000;

    return new Date(nextTargetIstMs - DAILY_REFRESH_IST_OFFSET_MS);
  }

  function waitForFullDetailsReady(lang, catalogVersionId) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeoutMs = 6 * 60 * 60 * 1000;

      const poll = () => {
        const cachePayload = readFullDetailsCache(lang, catalogVersionId);
        if (cachePayload && Array.isArray(cachePayload.fullDetails)) {
          resolve(cachePayload);
          return;
        }

        const job = getFullDetailsJobStatus(lang, catalogVersionId);
        if (job?.status === "failed") {
          reject(
            new Error(
              job.error ||
                `Full details refresh failed for catalogVersionId ${catalogVersionId}.`,
            ),
          );
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(
            new Error(
              `Timed out waiting for full details refresh for catalogVersionId ${catalogVersionId}.`,
            ),
          );
          return;
        }

        setTimeout(poll, 5000);
      };

      poll();
    });
  }

  async function runDailyRefreshWorkflow(reason = "scheduled", options = {}) {
    if (dailyRefreshRunning) {
      return {
        status: "skipped",
        reason: "Daily refresh is already running.",
        lastRun: lastDailyRefreshRun,
      };
    }

    dailyRefreshRunning = true;
    const startedAt = new Date().toISOString();
    const lang = options.lang || DAILY_REFRESH_LANG;
    const catalogVersionIds = await resolveCatalogVersionIds({
      lang,
      catalogVersionIds: options.catalogVersionIds,
    });
    const spacingMs = Math.max(
      0,
      Number(options.spacingMinutes ?? DAILY_REFRESH_SPACING_MINUTES) *
        60 *
        1000,
    );
    const results = [];
    currentDailyRefreshRun = {
      status: "running",
      reason,
      startedAt,
      lang,
      catalogVersionIds,
      spacingMinutes: spacingMs / 60000,
    };

    console.log("Daily refresh workflow started.", {
      reason,
      startedAt,
      lang,
      catalogVersionIds,
    });

    try {
      for (let index = 0; index < catalogVersionIds.length; index += 1) {
        const catalogVersionId = catalogVersionIds[index];
        const stepResult = {
          catalogVersionId,
          startedAt: new Date().toISOString(),
          products: null,
          fullDetails: null,
          productJson: null,
        };

        const result = await ensureFullDetailsCache(
          catalogVersionId,
          lang,
          true,
        );
        const fullDetailsCache =
          result.cachePayload ||
          (result.jobPromise ? await result.jobPromise : null) ||
          (await waitForFullDetailsReady(lang, catalogVersionId));

        const productCache = readProductCache(lang, catalogVersionId);
        stepResult.products = {
          total: Array.isArray(productCache?.items)
            ? productCache.items.length
            : 0,
          updatedAt: productCache?.updatedAt || "",
        };

        const finalFullDetails =
          fullDetailsCache || readFullDetailsCache(lang, catalogVersionId);
        stepResult.fullDetails = {
          total: Array.isArray(finalFullDetails?.fullDetails)
            ? finalFullDetails.fullDetails.length
            : 0,
          updatedAt: finalFullDetails?.updatedAt || "",
        };

        if (!Array.isArray(finalFullDetails?.fullDetails)) {
          throw new Error(
            `Full details cache was not generated for catalogVersionId ${catalogVersionId}.`,
          );
        }

        const productJsonResult = buildProductTypeExports(
          finalFullDetails.fullDetails,
          lang,
          catalogVersionId,
        );
        setProductTypeExportJobStatus(lang, catalogVersionId, {
          status: "ready",
          startedAt: new Date().toISOString(),
          total: finalFullDetails.fullDetails.length,
          error: "",
          result: productJsonResult,
        });

        stepResult.productJson = {
          totalFiles: productJsonResult.totalFiles,
          totalProducts: productJsonResult.totalProducts,
          catalogName: productJsonResult.catalogName,
        };
        stepResult.completedAt = new Date().toISOString();

        results.push(stepResult);
        currentDailyRefreshRun = {
          ...currentDailyRefreshRun,
          completedCatalogVersionIds: results.map(
            (result) => result.catalogVersionId,
          ),
          results,
        };

        if (index < catalogVersionIds.length - 1 && spacingMs > 0) {
          currentDailyRefreshRun = {
            ...currentDailyRefreshRun,
            waitingUntil: new Date(Date.now() + spacingMs).toISOString(),
            nextCatalogVersionId: catalogVersionIds[index + 1],
          };
          await wait(spacingMs);
        }
      }

      const cleanup =
        reason === "scheduled" && typeof pruneDailyRefreshCache === "function"
          ? pruneDailyRefreshCache(
              catalogVersionIds,
              results
                .map((result) => result.productJson?.catalogName)
                .filter(Boolean),
            )
          : null;

      const completedAt = new Date().toISOString();
      lastDailyRefreshRun = {
        status: "ready",
        reason,
        startedAt,
        completedAt,
        durationMs: getDurationMs(startedAt, completedAt),
        lang,
        catalogVersionIds,
        spacingMinutes: spacingMs / 60000,
        results,
        cleanup,
      };
      console.log("Daily refresh workflow completed.", lastDailyRefreshRun);
      return lastDailyRefreshRun;
    } catch (error) {
      const completedAt = new Date().toISOString();
      lastDailyRefreshRun = {
        status: "failed",
        reason,
        startedAt,
        completedAt,
        durationMs: getDurationMs(startedAt, completedAt),
        lang,
        catalogVersionIds,
        spacingMinutes: spacingMs / 60000,
        error: error.message || "Daily refresh workflow failed.",
        results,
      };
      console.error("Daily refresh workflow failed.", lastDailyRefreshRun);
      throw error;
    } finally {
      dailyRefreshRunning = false;
      currentDailyRefreshRun = null;
    }
  }

  async function scheduleNextDailyRefresh() {
    if (!DAILY_REFRESH_ENABLED) {
      console.log("Daily refresh scheduler disabled.");
      return;
    }

    nextDailyRefreshRunAt = getNextIstRunDate();
    const delayMs = Math.max(
      nextDailyRefreshRunAt.getTime() - Date.now(),
      1000,
    );

    if (dailyRefreshTimer) {
      clearTimeout(dailyRefreshTimer);
    }

    dailyRefreshTimer = setTimeout(() => {
      runDailyRefreshWorkflow("scheduled").finally(scheduleNextDailyRefresh);
    }, delayMs);

    console.log("Daily refresh scheduler armed.", {
      nextRunAt: nextDailyRefreshRunAt.toISOString(),
      timeZone: "Asia/Kolkata",
      hour: DAILY_REFRESH_HOUR_IST,
      minute: DAILY_REFRESH_MINUTE_IST,
      catalogVersionIds: getDailyRefreshCatalogVersionIds(),
      selectedCatalogIds: (await readDailyRefreshSelection())
        .selectedCatalogIds,
    });
  }

  app.get("/api/daily-refresh/status", async (_req, res, next) => {
    try {
      const selected = await readDailyRefreshSelection();
      const configuredCatalogs =
        await buildDailyRefreshCatalogs(DAILY_REFRESH_LANG);
      res.json({
        enabled: DAILY_REFRESH_ENABLED,
        running: dailyRefreshRunning,
        nextRunAt: DAILY_REFRESH_ENABLED
          ? (nextDailyRefreshRunAt || getNextIstRunDate()).toISOString()
          : null,
        timeZone: "Asia/Kolkata",
        hour: DAILY_REFRESH_HOUR_IST,
        minute: DAILY_REFRESH_MINUTE_IST,
        lang: DAILY_REFRESH_LANG,
        spacingMinutes: DAILY_REFRESH_SPACING_MINUTES,
        selectedCatalogIds: selected.selectedCatalogIds,
        selectionUpdatedAt: selected.updatedAt,
        selectedCatalogs: configuredCatalogs.filter(
          (catalog) => catalog.selected,
        ),
        availableCatalogs: configuredCatalogs,
        catalogVersionIds: await resolveCatalogVersionIds(),
        currentRun: currentDailyRefreshRun
          ? {
              ...currentDailyRefreshRun,
              elapsedMs: getDurationMs(currentDailyRefreshRun.startedAt),
            }
          : null,
        lastRun: lastDailyRefreshRun,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/daily-refresh/selection",
    requireAuth,
    async (req, res, next) => {
      try {
        const selectedCatalogIds = Array.isArray(req.body?.selectedCatalogIds)
          ? req.body.selectedCatalogIds
          : [];
        const selections = Array.isArray(req.body?.selections)
          ? req.body.selections
          : selectedCatalogIds.map((catalogId) => ({
              catalogId,
              versionStrategy: "LATEST",
            }));
        const lang = req.body?.lang || DAILY_REFRESH_LANG;
        const saved = await writeDailyRefreshSelection(selections, lang);
        const availableCatalogs = await buildDailyRefreshCatalogs(lang);

        return res.json({
          ...saved,
          availableCatalogs,
          selectedCatalogs: availableCatalogs.filter(
            (catalog) => catalog.selected,
          ),
          catalogVersionIds: await resolveCatalogVersionIds({ lang }),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/daily-refresh/run", requireAuth, async (req, res, next) => {
    try {
      if (dailyRefreshRunning) {
        return res.status(202).json({
          status: "running",
          message: "Daily refresh is already running.",
          currentRun: currentDailyRefreshRun,
          lastRun: lastDailyRefreshRun,
        });
      }

      const bodyCatalogVersionIds = Array.isArray(req.body?.catalogVersionIds)
        ? req.body.catalogVersionIds
        : req.body?.catalogVersionId
          ? [req.body.catalogVersionId]
          : [];
      const lang = req.body?.lang || DAILY_REFRESH_LANG;
      const spacingMinutes =
        bodyCatalogVersionIds.length === 1
          ? 0
          : (req.body?.spacingMinutes ?? DAILY_REFRESH_SPACING_MINUTES);
      const catalogVersionIds = await resolveCatalogVersionIds({
        lang,
        catalogVersionIds: bodyCatalogVersionIds,
      });

      setTimeout(() => {
        runDailyRefreshWorkflow("manual", {
          lang,
          catalogVersionIds,
          spacingMinutes,
        }).catch((error) => {
          console.error("Manual daily refresh workflow failed.", {
            error: error.message || String(error),
            lastRun: lastDailyRefreshRun,
          });
        });
      }, 100);

      return res.status(202).json({
        status: "running",
        message: "Daily refresh workflow started.",
        currentRun: {
          status: "running",
          reason: "manual",
          startedAt: new Date().toISOString(),
          lang,
          catalogVersionIds,
          spacingMinutes,
        },
        lastRun: lastDailyRefreshRun,
      });
    } catch (error) {
      next(error);
    }
  });

  return {
    scheduleNextDailyRefresh,
    runDailyRefreshWorkflow,
  };
};

module.exports = { createDailyRefreshScheduler };
