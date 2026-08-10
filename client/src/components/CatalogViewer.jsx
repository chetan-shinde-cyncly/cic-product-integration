export default function CatalogViewer({
  catalog, catalogJson, versionIds, selectedVersionId, refreshRunning,
  onCopy, onTextareaClick, onVersionChange, onRunRefresh, children,
  getVersionCount, isCatalogActive,
}) {
  if (!catalog) return null;
  return (
    <section className="details-panel">
      <div className="details-heading">
        <div><p className="eyebrow">Viewing catalog</p>
          <h2>{catalog.name || catalog.title || "Unnamed catalog"}</h2></div>
        <span className="catalog-code-pill">ID {catalog.id || "-"}</span>
      </div>
      <div className="catalog-details-top">
        <p className="status">Selected catalog ID: {catalog.id || "-"}</p>
        <p className="status">Status: {isCatalogActive(catalog) ? "Active" : "Inactive"}
          {" | "}Version count: {getVersionCount(catalog)}</p>
        <div className="section-toolbar">
          <span className="resize-hint">Drag bottom-right corner to resize</span>
          <button type="button" className="copy-btn" onClick={() => onCopy(catalogJson, "Catalog details")}>Copy Text</button>
        </div>
        <textarea className="json-textarea" value={catalogJson} readOnly tabIndex={0}
          spellCheck={false} onClick={onTextareaClick} />
      </div>
      <div className="catalog-details-bottom">
        <div className="version-panel">
          <label className="version-label" htmlFor="catalog-version-select">Catalog version IDs</label>
          <select id="catalog-version-select" className="version-select"
            value={selectedVersionId} onChange={onVersionChange} disabled={!versionIds.length}>
            {!versionIds.length && <option value="">No versions available</option>}
            {versionIds.map((versionId) => <option key={versionId} value={String(versionId)}>{versionId}</option>)}
          </select>
          {selectedVersionId && <p className="status">Highest version ID: {versionIds[0]} | Selected: {selectedVersionId}
            {String(selectedVersionId) !== String(versionIds[0]) ? " | Older version selected" : ""}</p>}
          <div className="product-action-row">
            <button type="button" className="refresh-btn secondary-action" onClick={onRunRefresh}
              disabled={refreshRunning || !versionIds.length}>
              {refreshRunning ? "Daily Refresh Running..." : "Run Daily Refresh For This Site"}
            </button>
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}
