export default function CatalogList({
  catalogs,
  filteredCatalogs,
  selectedCatalogId,
  searchTerm,
  activeFilter,
  activeCount,
  inactiveCount,
  onSearchChange,
  onFilterChange,
  onSelectCatalog,
  getVersionCount,
  getVersionIds,
  isCatalogActive,
  children,
}) {
  return (
    <>
      <div className="catalog-toolbar">
        <input type="text" value={searchTerm} onChange={onSearchChange}
          className="search-input" placeholder="Search by catalog name or ID" />
        <div className="filter-group">
          {[
            ["all", "All", catalogs.length],
            ["active", "Active", activeCount],
            ["inactive", "Inactive", inactiveCount],
          ].map(([value, label, count]) => (
            <button key={value} type="button"
              className={`filter-btn ${activeFilter === value ? "active-filter" : ""}`}
              onClick={() => onFilterChange(value)}>{label} ({count})</button>
          ))}
        </div>
      </div>
      <p className="status">Showing {filteredCatalogs.length} of {catalogs.length} catalogs</p>
      <div className="catalog-layout">
      <aside className="catalog-list-panel">
        <h2>Catalog List</h2>
        <div className="catalog-list" role="list">
          {filteredCatalogs.map((catalog, index) => (
            <button key={catalog.id || `${catalog.name}-${index}`} type="button"
              className={`catalog-item ${selectedCatalogId === catalog.id ? "selected-item" : ""}`}
              onClick={() => onSelectCatalog(catalog)}>
              <span className="catalog-item-index">{index + 1}</span>
              <span className="catalog-item-body">
                <strong>{catalog.name || catalog.title || "N/A"}</strong>
                <span>ID: {catalog.id || "-"}</span>
                <span>Status: {isCatalogActive(catalog) ? "Active" : "Inactive"}</span>
                <span>Version Count: {getVersionCount(catalog)}</span>
                <span>Version IDs: {getVersionIds(catalog)}</span>
              </span>
            </button>
          ))}
          {!filteredCatalogs.length && <p className="empty-state">No catalogs match the current filter.</p>}
        </div>
      </aside>
      {children}
      </div>
    </>
  );
}
