const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { createS3CatalogSync } = require("../services/s3CatalogSync");

function streamBody(value) {
  const body = Readable.from([Buffer.from(value)]);
  body.transformToByteArray = async () => Buffer.from(value);
  return body;
}

function createFakeS3(initialObjects = {}) {
  const objects = new Map(Object.entries(initialObjects));
  return {
    objects,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "ListObjectsV2Command") {
        return {
          Contents: [...objects.entries()]
            .filter(([key]) => key.startsWith(input.Prefix))
            .map(([Key, value]) => ({
              Key,
              Size: Buffer.byteLength(value),
              ETag: `\"${value}\"`,
              LastModified: new Date(0),
            })),
        };
      }
      if (name === "GetObjectCommand") {
        return { Body: streamBody(objects.get(input.Key)) };
      }
      if (name === "PutObjectCommand") {
        const chunks = [];
        for await (const chunk of input.Body) chunks.push(chunk);
        objects.set(input.Key, Buffer.concat(chunks).toString("utf8"));
        return {};
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(input.Key);
        return {};
      }
      throw new Error(`Unexpected command: ${name}`);
    },
    destroy() {},
  };
}

test("S3 catalog sync hydrates local storage and uploads local changes", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cic-s3-sync-"));
  fs.writeFileSync(path.join(rootDir, "existing.json"), '{"existing":true}');
  const client = createFakeS3({
    "catalogs/generated/example.json": '{"remote":true}',
  });
  const storage = createS3CatalogSync({
    rootDir,
    bucket: "test-bucket",
    client,
    intervalMs: 60000,
    logger: { log() {}, error() {} },
  });

  await storage.start();
  assert.equal(
    fs.readFileSync(path.join(rootDir, "generated", "example.json"), "utf8"),
    '{"remote":true}',
  );
  assert.equal(
    client.objects.get("catalogs/existing.json"),
    '{"existing":true}',
  );

  fs.writeFileSync(path.join(rootDir, "local.json"), '{"local":true}');
  await storage.syncNow();
  assert.equal(client.objects.get("catalogs/local.json"), '{"local":true}');

  fs.rmSync(path.join(rootDir, "local.json"));
  await storage.syncNow();
  assert.equal(client.objects.has("catalogs/local.json"), false);

  client.objects.set("catalogs/generated/example.json", '{"remote":2}');
  await storage.syncNow();
  assert.equal(
    fs.readFileSync(path.join(rootDir, "generated", "example.json"), "utf8"),
    '{"remote":2}',
  );

  client.objects.delete("catalogs/generated/example.json");
  await storage.syncNow();
  assert.equal(
    fs.existsSync(path.join(rootDir, "generated", "example.json")),
    false,
  );
  await storage.stop();
});

test("S3 catalog sync rejects object keys that escape the catalog root", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cic-s3-safe-"));
  const client = createFakeS3({ "catalogs/../outside.json": "unsafe" });
  const storage = createS3CatalogSync({
    rootDir,
    bucket: "test-bucket",
    client,
    intervalMs: 60000,
    logger: { log() {}, error() {} },
  });

  await storage.start();
  assert.equal(fs.existsSync(path.join(rootDir, "..", "outside.json")), false);
  await storage.stop();
});
