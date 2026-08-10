export default function ConsoleHeader({
  user, loading, error, metadata, activePage, catalogCount, activeCount,
  inactiveCount, selectedVersionId, selectedRefreshCount, refreshRunning,
  refreshDurationText, refreshStatusText, refreshError, onLogout,
  onRefreshCatalogs, onRunRefresh, onPageChange,
}) {
  return (
    <>
      <header className="app-header">
        <div>
          <p className="eyebrow">Catalog integration console</p>
          <h1>Cyncly Catalogs</h1>
          <p className="subtitle">Review catalog versions, refresh cached product data, and export generated JSON files.</p>
        </div>
        <div className="header-actions">
          {user && <div className="auth-status">
            <span>Signed in as {user.username}</span>
            <button type="button" className="copy-btn secondary-action" onClick={onLogout}>Sign out</button>
          </div>}
          <button type="button" onClick={onRefreshCatalogs} disabled={loading} className="refresh-btn">
            {loading ? "Fetching..." : "Refresh Catalogs"}
          </button>
          <button type="button" onClick={onRunRefresh} disabled={refreshRunning} className="refresh-btn secondary-action">
            {refreshRunning ? "Daily Refresh Running..." : "Run Daily Refresh Now"}
          </button>
        </div>
      </header>

      <nav className="page-tabs" aria-label="Console pages">
        <button type="button" className={`filter-btn ${activePage === "catalogs" ? "active-filter" : ""}`}
          onClick={() => onPageChange("catalogs")}>Catalog Details</button>
        <button type="button" className={`filter-btn ${activePage === "daily-refresh" ? "active-filter" : ""}`}
          onClick={() => onPageChange("daily-refresh")}>Daily Refresh Catalogs</button>
      </nav>

      <section className="summary-grid" aria-label="Catalog summary">
        <div className="summary-card"><span>Total catalogs</span><strong>{catalogCount}</strong></div>
        <div className="summary-card"><span>Active</span><strong>{activeCount}</strong></div>
        <div className="summary-card"><span>Inactive</span><strong>{inactiveCount}</strong></div>
        <div className="summary-card">
          <span>{activePage === "daily-refresh" ? "Refresh catalogs" : "Selected version"}</span>
          <strong>{activePage === "daily-refresh" ? selectedRefreshCount : selectedVersionId || "-"}</strong>
        </div>
      </section>

      <div className="notice-stack">
        {refreshDurationText && <p className="status">{refreshDurationText}</p>}
        {loading && <p className="status">Loading catalogs...</p>}
        {error && <p className="status error">{error}</p>}
        {refreshStatusText && <p className="status">{refreshStatusText}</p>}
        {refreshError && <p className="status error">{refreshError}</p>}
        {metadata?.updatedAt && <p className="status">
          Source: {metadata.source} | Last updated: {new Date(metadata.updatedAt).toLocaleString()}
        </p>}
      </div>
    </>
  );
}
