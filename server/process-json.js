const fs = require("fs");
const path = require("path");

const DEFAULT_CATALOG_NAME = "Jabara's Carpet Outlet";
const DEFAULT_PRODUCT_TYPE = "lvt";
const ARRAY_TO_FACET_FIELDS = ["surface_texture", "finish"];
const DIRECT_FACET_FIELDS = [
  "size",
  "species",
  "thickness",
  "wear_layer_thickness",
  "backing",
  "location",
];

function sanitizeFileSegment(value, fallback = "unknown") {
  const sanitized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();

  return sanitized || fallback;
}

function buildGeneratedFilePath(catalogName, productType) {
  return path.join(
    __dirname,
    "catalogs",
    "generated",
    sanitizeFileSegment(catalogName, "unknown-catalog"),
    `cic_${sanitizeFileSegment(productType, "unknown")}.json`,
  );
}

function uniqueListToText(value) {
  return Array.isArray(value) ? [...new Set(value)].join(", ") : value;
}

function addFacetFields(product) {
  const nextProduct = { ...product };

  for (const fieldName of ARRAY_TO_FACET_FIELDS) {
    nextProduct[fieldName] = uniqueListToText(nextProduct[fieldName]);
    nextProduct[`${fieldName}_facet`] = nextProduct[fieldName];
  }

  for (const fieldName of DIRECT_FACET_FIELDS) {
    nextProduct[`${fieldName}_facet`] = nextProduct[fieldName];
  }

  return nextProduct;
}

function processGeneratedProductFile(filePath) {
  const products = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (!Array.isArray(products)) {
    throw new Error("Generated product file must contain a JSON array.");
  }

  const updatedProducts = products.map(addFacetFields);
  fs.writeFileSync(filePath, JSON.stringify(updatedProducts, null, 2), "utf8");

  return {
    filePath,
    total: updatedProducts.length,
  };
}

const catalogName = process.argv[2] || DEFAULT_CATALOG_NAME;
const productType = process.argv[3] || DEFAULT_PRODUCT_TYPE;
const filePath = buildGeneratedFilePath(catalogName, productType);

try {
  const result = processGeneratedProductFile(filePath);
  console.log(`Updated ${result.total} products in ${result.filePath}`);
} catch (error) {
  console.error(error.message || "Failed to process generated product file.");
  process.exitCode = 1;
}
