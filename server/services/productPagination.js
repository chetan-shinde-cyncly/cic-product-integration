function createProductsFetcher({ fetchUrl, decodeProductsResponse }) {
  if (typeof fetchUrl !== "function" || typeof decodeProductsResponse !== "function") {
    throw new TypeError("fetchUrl and decodeProductsResponse are required.");
  }

  return async function fetchProductsByCatalogVersionId(catalogVersionId) {
    const baseUrl = "https://management.cyncly-content.com/item-offering/api/v1/items";
    const allResults = [];
    const seenTokens = new Set();
    let continuationToken = "";
    let mergedPayload = null;

    do {
      const params = new URLSearchParams({ catalogVersionId: String(catalogVersionId) });
      if (continuationToken) params.set("continuationToken", continuationToken);

      const response = await fetchUrl(`${baseUrl}?${params.toString()}`, { timeout: 30000 });
      const decoded = decodeProductsResponse(await response.arrayBuffer());
      const parsed = JSON.parse(decoded);

      if (!response.ok) throw new Error(parsed.message || "Products API request failed.");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Products API returned an invalid paginated response.");
      }
      if (!Array.isArray(parsed.results)) {
        throw new Error("Products API response is missing the results array.");
      }

      if (!mergedPayload) mergedPayload = { ...parsed };
      allResults.push(...parsed.results);

      const nextToken = String(parsed.continuationToken || "").trim();
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error(`Products API returned a repeated continuationToken: ${nextToken}`);
      }
      if (nextToken) seenTokens.add(nextToken);
      continuationToken = nextToken;
    } while (continuationToken);

    return { ...(mergedPayload || {}), continuationToken: "", results: allResults };
  };
}

module.exports = { createProductsFetcher };
