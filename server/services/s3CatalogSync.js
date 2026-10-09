const fs = require("fs");
const path = require("path");
const {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

function normalizePrefix(value) {
  const trimmed = String(value || "catalogs").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function localSignature(stats) {
  return `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

function remoteSignature(object) {
  return `${object.Size || 0}:${object.ETag || ""}:${
    object.LastModified ? new Date(object.LastModified).getTime() : 0
  }`;
}

function createS3CatalogSync({
  rootDir,
  bucket = process.env.CATALOG_STORAGE_BUCKET,
  prefix = process.env.CATALOG_STORAGE_PREFIX || "catalogs",
  intervalMs = Number(process.env.CATALOG_STORAGE_SYNC_INTERVAL_MS || 15000),
  client = new S3Client({}),
  logger = console,
} = {}) {
  if (!rootDir) throw new Error("S3 catalog sync requires rootDir.");
  if (!bucket) throw new Error("S3 catalog sync requires CATALOG_STORAGE_BUCKET.");
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error("CATALOG_STORAGE_SYNC_INTERVAL_MS must be at least 1000.");
  }

  const objectPrefix = normalizePrefix(prefix);
  let knownLocal = new Map();
  let knownRemote = new Map();
  let timer = null;
  let activeSync = null;
  let stopped = false;

  function objectKey(relativePath) {
    return `${objectPrefix}${toPosixPath(relativePath)}`;
  }

  function relativePathForKey(key) {
    if (!key.startsWith(objectPrefix)) return null;
    const relativePath = key.slice(objectPrefix.length);
    if (!relativePath || relativePath.endsWith("/")) return null;
    const normalized = path.normalize(relativePath);
    if (
      path.isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`)
    ) {
      return null;
    }
    return normalized;
  }

  function scanLocalFiles() {
    const files = new Map();
    if (!fs.existsSync(rootDir)) return files;

    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(filePath);
        } else if (entry.isFile()) {
          const relativePath = path.relative(rootDir, filePath);
          files.set(relativePath, {
            filePath,
            signature: localSignature(fs.statSync(filePath)),
          });
        }
      }
    }

    visit(rootDir);
    return files;
  }

  async function listRemoteFiles() {
    const files = new Map();
    let continuationToken;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: objectPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents || []) {
        const relativePath = relativePathForKey(object.Key || "");
        if (relativePath) {
          files.set(relativePath, {
            key: object.Key,
            signature: remoteSignature(object),
          });
        }
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return files;
  }

  async function downloadFile(relativePath, key) {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const filePath = path.join(rootDir, relativePath);
    const temporaryPath = `${filePath}.s3-download`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const bytes = await response.Body.transformToByteArray();
    fs.writeFileSync(temporaryPath, Buffer.from(bytes));
    fs.renameSync(temporaryPath, filePath);
  }

  async function uploadFile(relativePath, filePath) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey(relativePath),
        Body: fs.createReadStream(filePath),
        ContentType: relativePath.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      }),
    );
  }

  async function deleteRemoteFile(relativePath) {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: objectKey(relativePath),
      }),
    );
  }

  function deleteLocalFile(relativePath) {
    const filePath = path.join(rootDir, relativePath);
    fs.rmSync(filePath, { force: true });
    let directory = path.dirname(filePath);
    while (directory !== rootDir && directory.startsWith(rootDir)) {
      try {
        fs.rmdirSync(directory);
      } catch (_error) {
        break;
      }
      directory = path.dirname(directory);
    }
  }

  async function hydrate() {
    fs.mkdirSync(rootDir, { recursive: true });
    const remote = await listRemoteFiles();
    const local = scanLocalFiles();

    for (const [relativePath, localFile] of local) {
      if (!remote.has(relativePath)) {
        await uploadFile(relativePath, localFile.filePath);
      }
    }

    for (const [relativePath, remoteFile] of remote) {
      if (!local.has(relativePath)) {
        await downloadFile(relativePath, remoteFile.key);
      }
    }

    knownRemote = await listRemoteFiles();
    knownLocal = new Map(
      [...scanLocalFiles()].map(([name, file]) => [name, file.signature]),
    );
    logger.log("S3 catalog storage hydrated.", {
      bucket,
      prefix: objectPrefix,
      files: knownLocal.size,
    });
  }

  async function synchronizeOnce() {
    const remoteBefore = await listRemoteFiles();
    let local = scanLocalFiles();
    const locallyChanged = new Set();

    for (const [relativePath, file] of local) {
      if (knownLocal.get(relativePath) !== file.signature) {
        locallyChanged.add(relativePath);
        await uploadFile(relativePath, file.filePath);
      }
    }

    for (const relativePath of knownLocal.keys()) {
      if (!local.has(relativePath)) {
        locallyChanged.add(relativePath);
        await deleteRemoteFile(relativePath);
      }
    }

    for (const [relativePath, remoteFile] of remoteBefore) {
      const remoteChanged =
        knownRemote.get(relativePath)?.signature !== remoteFile.signature;
      if (remoteChanged && !locallyChanged.has(relativePath)) {
        await downloadFile(relativePath, remoteFile.key);
      }
    }

    for (const relativePath of knownRemote.keys()) {
      if (!remoteBefore.has(relativePath) && !locallyChanged.has(relativePath)) {
        deleteLocalFile(relativePath);
      }
    }

    local = scanLocalFiles();
    knownLocal = new Map(
      [...local].map(([name, file]) => [name, file.signature]),
    );
    knownRemote = await listRemoteFiles();
  }

  function syncNow() {
    if (activeSync) return activeSync;
    activeSync = synchronizeOnce().finally(() => {
      activeSync = null;
    });
    return activeSync;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await syncNow();
      } catch (error) {
        logger.error("S3 catalog synchronization failed.", {
          error: error.message || String(error),
        });
      } finally {
        schedule();
      }
    }, intervalMs);
    timer.unref?.();
  }

  async function start() {
    await hydrate();
    schedule();
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    await syncNow();
    client.destroy?.();
  }

  return { start, stop, syncNow };
}

module.exports = { createS3CatalogSync };
