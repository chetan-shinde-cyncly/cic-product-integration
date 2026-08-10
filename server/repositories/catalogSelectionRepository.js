function createCatalogSelectionRepository(pool) {
  return {
    async listDailyRefresh(language = "en-US") {
      const result = await pool.query(
        `SELECT catalog_id, catalog_version_id, catalog_name, site_code,
                language, version_strategy, enabled, updated_at
         FROM catalog_selections
         WHERE user_id IS NULL AND selection_type = 'DAILY_REFRESH'
           AND language = $1 AND enabled = true
         ORDER BY created_at`,
        [language],
      );
      return result.rows.map((row) => ({
        catalogId: row.catalog_id,
        catalogVersionId: row.catalog_version_id,
        catalogName: row.catalog_name,
        siteCode: row.site_code,
        language: row.language,
        versionStrategy: row.version_strategy,
        enabled: row.enabled,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
      }));
    },

    async replaceDailyRefresh(selections, language = "en-US") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM catalog_selections WHERE user_id IS NULL AND selection_type = 'DAILY_REFRESH' AND language = $1",
          [language],
        );
        for (const selection of selections) {
          await client.query(
            `INSERT INTO catalog_selections
             (catalog_id, catalog_version_id, catalog_name, site_code, language, selection_type, version_strategy)
             VALUES ($1, $2, $3, $4, $5, 'DAILY_REFRESH', $6)`,
            [selection.catalogId, selection.catalogVersionId || null, selection.catalogName || null,
              selection.siteCode || null, language, selection.versionStrategy],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return this.listDailyRefresh(language);
    },
  };
}

module.exports = { createCatalogSelectionRepository };

