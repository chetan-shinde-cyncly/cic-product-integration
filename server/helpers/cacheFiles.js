const fs = require("fs");
const path = require("path");

const createCacheFileHelpers = ({ cacheDir, generatedDir, oneDayMs }) => {
  const LOCKED_FILE_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
  const GENERATED_PRODUCT_TYPE_FILE_PREFIX = "cic_";

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  if (!fs.existsSync(generatedDir)) {
    fs.mkdirSync(generatedDir, { recursive: true });
  }

  function cacheFilePath(lang) {
    const safeLang = String(lang || "en-US").replace(/[^a-zA-Z0-9-_]/g, "_");
    return path.join(cacheDir, `catalogs-${safeLang}.json`);
  }

  function productCacheFilePath(lang, catalogVersionId) {
    const safeLang = String(lang || "en-US").replace(/[^a-zA-Z0-9-_]/g, "_");
    const safeCatalogVersionId = String(catalogVersionId || "unknown").replace(
      /[^a-zA-Z0-9-_]/g,
      "_",
    );
    return path.join(
      cacheDir,
      `products-${safeLang}-${safeCatalogVersionId}.json`,
    );
  }

  function fullDetailsCacheFilePath(lang, catalogVersionId) {
    const safeLang = String(lang || "en-US").replace(/[^a-zA-Z0-9-_]/g, "_");
    const safeCatalogVersionId = String(catalogVersionId || "unknown").replace(
      /[^a-zA-Z0-9-_]/g,
      "_",
    );
    return path.join(
      cacheDir,
      `full-details-${safeLang}-${safeCatalogVersionId}.json`,
    );
  }

  function itemDetailsCacheFilePath(lang, catalogVersionId) {
    const safeLang = String(lang || "en-US").replace(/[^a-zA-Z0-9-_]/g, "_");
    const safeCatalogVersionId = String(catalogVersionId || "unknown").replace(
      /[^a-zA-Z0-9-_]/g,
      "_",
    );
    return path.join(
      cacheDir,
      "item-details",
      `item-details-${safeLang}-${safeCatalogVersionId}.json`,
    );
  }

  function dailyRefreshSelectionFilePath() {
    return path.join(cacheDir, "daily-refresh-selection.json");
  }

  function sanitizeFileSegment(value, fallback = "unknown") {
    const sanitized = String(value || "")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\.+$/g, "")
      .trim();

    return sanitized || fallback;
  }

  function generatedCatalogDirPath(catalogName) {
    return path.join(
      generatedDir,
      sanitizeFileSegment(catalogName, "unknown-catalog"),
    );
  }

  function getGeneratedProductTypeFileName(productType) {
    return `${GENERATED_PRODUCT_TYPE_FILE_PREFIX}${sanitizeFileSegment(
      productType,
      "unknown",
    )}.json`;
  }

  function getProductTypeFromGeneratedFileName(fileName) {
    const safeFileName = String(fileName || "").trim();
    const baseName = path.basename(safeFileName, ".json");
    if (!baseName) {
      return "unknown";
    }

    return baseName.replace(
      new RegExp(`^${GENERATED_PRODUCT_TYPE_FILE_PREFIX}`, "i"),
      "",
    );
  }

  function isGeneratedProductTypeFileName(fileName) {
    return /^cic_[^\\/]+\.json$/i.test(String(fileName || ""));
  }

  function normalizeLegacyGeneratedProductTypeFiles(catalogDir) {
    if (!fs.existsSync(catalogDir)) {
      return [];
    }

    const normalized = [];
    for (const entryName of fs.readdirSync(catalogDir)) {
      const sourcePath = path.join(catalogDir, entryName);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile() || !entryName.toLowerCase().endsWith(".json")) {
        continue;
      }

      const baseName = path.basename(entryName, ".json");
      if (
        baseName.toLowerCase() === "unknown" ||
        isGeneratedProductTypeFileName(entryName)
      ) {
        continue;
      }

      const targetFileName = getGeneratedProductTypeFileName(baseName);
      const targetPath = path.join(catalogDir, targetFileName);

      if (fs.existsSync(targetPath)) {
        deleteFileIfExists(sourcePath);
        continue;
      }

      try {
        fs.renameSync(sourcePath, targetPath);
        normalized.push(targetFileName);
      } catch (error) {
        console.warn("Unable to normalize legacy generated product file.", {
          filePath: sourcePath,
          error: error.message || String(error),
        });
      }
    }

    return normalized;
  }

  function readCache(lang) {
    const filePath = cacheFilePath(lang);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function writeCache(lang, items) {
    const filePath = cacheFilePath(lang);
    const payload = {
      lang,
      updatedAt: new Date().toISOString(),
      items,
    };
    writeJsonFile(filePath, payload);
    return payload;
  }

  function readProductCache(lang, catalogVersionId) {
    const filePath = productCacheFilePath(lang, catalogVersionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function writeProductCache(lang, catalogVersionId, payload) {
    const filePath = productCacheFilePath(lang, catalogVersionId);
    const cachePayload = {
      lang,
      catalogVersionId,
      updatedAt: new Date().toISOString(),
      ...payload,
    };
    writeJsonFile(filePath, cachePayload);
    return cachePayload;
  }

  function catalogDependencyCacheFilePath(retailerCode, catalogName) {
    const safeRetailerCode = sanitizeFileSegment(
      String(retailerCode || ""),
    ).replace(/\s+/g, "-");
    const siteDirName = sanitizeFileSegment(
      String(catalogName || ""),
      "unknown-site",
    );
    const depsDir = path.join(cacheDir, "dependencies", siteDirName);
    if (!fs.existsSync(depsDir)) {
      fs.mkdirSync(depsDir, { recursive: true });
    }
    return path.join(depsDir, `catalog-dependencies-${safeRetailerCode}.json`);
  }

  function readCatalogDependencyCache(retailerCode, catalogName) {
    const filePath = catalogDependencyCacheFilePath(retailerCode, catalogName);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function writeCatalogDependencyCache(retailerCode, data, catalogName) {
    const filePath = catalogDependencyCacheFilePath(retailerCode, catalogName);
    const cachePayload = {
      updatedAt: new Date().toISOString(),
      data,
    };
    writeJsonFile(filePath, cachePayload);
    return cachePayload;
  }

  function isLockedFileError(error) {
    return LOCKED_FILE_ERROR_CODES.has(error?.code);
  }

  function deleteFileIfExists(filePath) {
    if (fs.existsSync(filePath)) {
      try {
        fs.chmodSync(filePath, 0o666);
      } catch (_error) {
        // Best effort: chmod can fail for locked files, but rm may still succeed.
      }

      try {
        fs.rmSync(filePath, {
          force: true,
          maxRetries: 8,
          retryDelay: 150,
        });
        return true;
      } catch (error) {
        if (isLockedFileError(error)) {
          try {
            fs.truncateSync(filePath, 0);
          } catch (_truncateError) {
            // If another process owns the handle, even truncate can be blocked.
          }

          console.warn("Unable to delete cache file; continuing refresh.", {
            filePath,
            error: error.message || String(error),
          });
          return false;
        }

        console.warn("Unable to delete cache file; continuing.", {
          filePath,
          error: error.message || String(error),
        });
        return false;
      }
    }

    return false;
  }

  function deleteFullDetailsCache(lang, catalogVersionId) {
    return deleteFileIfExists(fullDetailsCacheFilePath(lang, catalogVersionId));
  }

  function deleteItemDetailsCache(lang, catalogVersionId) {
    return deleteFileIfExists(itemDetailsCacheFilePath(lang, catalogVersionId));
  }

  function deleteProductCache(lang, catalogVersionId) {
    return deleteFileIfExists(productCacheFilePath(lang, catalogVersionId));
  }

  function deleteDirectoryIfExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
      return false;
    }

    try {
      fs.rmSync(dirPath, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      });
      return true;
    } catch (error) {
      if (isLockedFileError(error)) {
        console.warn("Unable to delete cache directory; continuing.", {
          dirPath,
          error: error.message || String(error),
        });
        return false;
      }

      console.warn("Unable to delete cache directory; continuing.", {
        dirPath,
        error: error.message || String(error),
      });
      return false;
    }
  }

  function isPathInside(parentPath, childPath) {
    const relative = path.relative(
      path.resolve(parentPath),
      path.resolve(childPath),
    );
    return (
      Boolean(relative) &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  }

  function readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function writeJsonFile(filePath, payload, pretty = false) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = JSON.stringify(payload, null, pretty ? 2 : 0);

    try {
      fs.writeFileSync(filePath, content, "utf-8");
    } catch (error) {
      if (!isLockedFileError(error)) {
        throw error;
      }

      const fallbackPath = `${filePath}.next`;
      fs.writeFileSync(fallbackPath, content, "utf-8");
      console.warn(
        "Unable to overwrite locked cache file; wrote fallback file.",
        {
          filePath,
          fallbackPath,
          error: error.message || String(error),
        },
      );
    }
  }

  function listJsonFiles(dirPath) {
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    return fs
      .readdirSync(dirPath)
      .filter((fileName) => fileName.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }

    return table;
  })();

  function calculateCrc32(buffer) {
    let crc = 0xffffffff;

    for (const byte of buffer) {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  function getZipDateParts(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1);
    const dosDate =
      ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    return {
      dosTime,
      dosDate,
    };
  }

  function writeZipFileToResponse(res, files) {
    const centralDirectory = [];
    let offset = 0;

    for (const file of files) {
      const data = fs.readFileSync(file.path);
      const nameBuffer = Buffer.from(file.name, "utf-8");
      const crc32 = calculateCrc32(data);
      const stats = fs.statSync(file.path);
      const { dosTime, dosDate } = getZipDateParts(stats.mtime);

      const localHeader = Buffer.alloc(30 + nameBuffer.length);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(crc32, 14);
      localHeader.writeUInt32LE(data.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28);
      nameBuffer.copy(localHeader, 30);

      res.write(localHeader);
      res.write(data);

      centralDirectory.push({
        nameBuffer,
        crc32,
        size: data.length,
        dosTime,
        dosDate,
        offset,
      });

      offset += localHeader.length + data.length;
    }

    const centralDirectoryStart = offset;

    for (const entry of centralDirectory) {
      const header = Buffer.alloc(46 + entry.nameBuffer.length);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.dosTime, 12);
      header.writeUInt16LE(entry.dosDate, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBuffer.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset, 42);
      entry.nameBuffer.copy(header, 46);

      res.write(header);
      offset += header.length;
    }

    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(centralDirectory.length, 8);
    endRecord.writeUInt16LE(centralDirectory.length, 10);
    endRecord.writeUInt32LE(offset - centralDirectoryStart, 12);
    endRecord.writeUInt32LE(centralDirectoryStart, 16);
    endRecord.writeUInt16LE(0, 20);

    res.end(endRecord);
  }

  function buildFileMetadata(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);
    return {
      fileName: path.basename(filePath),
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
    };
  }

  function pruneStaleGeneratedProductTypeFiles(catalogDir, currentFileNames) {
    const currentFiles = new Set(currentFileNames);

    for (const fileName of listJsonFiles(catalogDir)) {
      if (currentFiles.has(fileName)) {
        continue;
      }

      const filePath = path.join(catalogDir, fileName);
      const deleted = deleteFileIfExists(filePath);
      if (!deleted) {
        console.warn("Unable to remove stale generated product JSON file.", {
          filePath,
        });
      }
    }
  }

  function pruneDailyRefreshCache(activeCatalogVersionIds, activeCatalogNames) {
    const activeVersionIds = new Set(
      (activeCatalogVersionIds || []).map((value) => String(value).trim()),
    );
    const activeNames = new Set(
      (activeCatalogNames || []).map((value) =>
        sanitizeFileSegment(value, "unknown-catalog"),
      ),
    );
    const summary = {
      deletedFiles: 0,
      deletedDirectories: 0,
      reclaimedBytes: 0,
      failedPaths: [],
    };

    if (!activeVersionIds.size) {
      throw new Error(
        "Refusing to prune daily refresh cache without active catalog versions.",
      );
    }

    function recordFileDeletion(filePath) {
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch (_error) {
        return;
      }

      if (deleteFileIfExists(filePath)) {
        summary.deletedFiles += 1;
        summary.reclaimedBytes += size;
      } else {
        summary.failedPaths.push(filePath);
      }
    }

    function recordDirectoryDeletion(dirPath) {
      let size = 0;
      let fileCount = 0;
      const collectSize = (currentPath) => {
        for (const entry of fs.readdirSync(currentPath, {
          withFileTypes: true,
        })) {
          const entryPath = path.join(currentPath, entry.name);
          if (entry.isDirectory()) {
            collectSize(entryPath);
          } else {
            size += fs.statSync(entryPath).size;
            fileCount += 1;
          }
        }
      };

      collectSize(dirPath);
      if (deleteDirectoryIfExists(dirPath)) {
        summary.deletedDirectories += 1;
        summary.deletedFiles += fileCount;
        summary.reclaimedBytes += size;
      } else {
        summary.failedPaths.push(dirPath);
      }
    }

    const cachePatterns = [
      {
        dirPath: cacheDir,
        pattern: /^products-.+-([^-]+)\.json$/,
      },
      {
        dirPath: cacheDir,
        pattern: /^full-details-.+-([^-]+)\.json$/,
      },
      {
        dirPath: path.join(cacheDir, "item-details"),
        pattern: /^item-details-.+-([^-]+)\.json$/,
      },
    ];

    for (const { dirPath, pattern } of cachePatterns) {
      if (!fs.existsSync(dirPath)) {
        continue;
      }

      for (const fileName of fs.readdirSync(dirPath)) {
        const match = fileName.match(pattern);
        if (match && !activeVersionIds.has(match[1])) {
          recordFileDeletion(path.join(dirPath, fileName));
        }
      }
    }

    for (const parentDir of [
      generatedDir,
      path.join(cacheDir, "dependencies"),
    ]) {
      if (!fs.existsSync(parentDir)) {
        continue;
      }

      for (const entry of fs.readdirSync(parentDir, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() && !activeNames.has(entry.name)) {
          recordDirectoryDeletion(path.join(parentDir, entry.name));
        }
      }
    }

    return summary;
  }

  function isCacheFresh(cachePayload) {
    if (!cachePayload || !cachePayload.updatedAt) {
      return false;
    }

    const updatedAt = new Date(cachePayload.updatedAt).getTime();
    if (!Number.isFinite(updatedAt)) {
      return false;
    }

    return Date.now() - updatedAt < oneDayMs;
  }

  return {
    cacheFilePath,
    productCacheFilePath,
    fullDetailsCacheFilePath,
    itemDetailsCacheFilePath,
    dailyRefreshSelectionFilePath,
    sanitizeFileSegment,
    generatedCatalogDirPath,
    getGeneratedProductTypeFileName,
    getProductTypeFromGeneratedFileName,
    isGeneratedProductTypeFileName,
    normalizeLegacyGeneratedProductTypeFiles,
    deleteFileIfExists,
    deleteFullDetailsCache,
    deleteItemDetailsCache,
    deleteProductCache,
    deleteDirectoryIfExists,
    isPathInside,
    readCache,
    writeCache,
    readProductCache,
    writeProductCache,
    catalogDependencyCacheFilePath,
    readCatalogDependencyCache,
    writeCatalogDependencyCache,
    readJsonFile,
    writeJsonFile,
    listJsonFiles,
    writeZipFileToResponse,
    buildFileMetadata,
    pruneStaleGeneratedProductTypeFiles,
    pruneDailyRefreshCache,
    isCacheFresh,
  };
};

module.exports = { createCacheFileHelpers };
