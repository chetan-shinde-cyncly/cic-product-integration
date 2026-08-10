export default function GeneratedFilesList({
  files, productTypeFiles, loading, error, buildDownloadUrl, formatFileSize,
}) {
  return (
    <>
      <h3>Generated Files</h3>
      {loading && <p className="status">Loading generated files...</p>}
      {error && <p className="status error">{error}</p>}
      {!loading && !error && <div className="generated-files-panel">
        <div className="generated-files-group">
          <h4>Full Details File</h4>
          {files?.fullDetails ? <a className="file-download-row"
            href={buildDownloadUrl(files.fullDetails.downloadUrl)} download={files.fullDetails.fileName}>
            <span><strong>{files.fullDetails.fileName}</strong><small>
              Updated: {new Date(files.fullDetails.updatedAt).toLocaleString()} | Size: {formatFileSize(files.fullDetails.sizeBytes)}
            </small></span><span>Download</span>
          </a> : <p className="empty-state">Full details JSON file is not generated yet.</p>}
        </div>
        <div className="generated-files-group">
          <h4>Product Type JSON Files</h4>
          {productTypeFiles.length ? <div className="file-download-list">
            {productTypeFiles.map((file) => <a key={file.fileName} className="file-download-row"
              href={buildDownloadUrl(file.downloadUrl)} download={file.fileName}>
              <span><strong>{file.title}</strong><small>{file.fileName} | Updated: {new Date(file.updatedAt).toLocaleString()} | Size: {formatFileSize(file.sizeBytes)}</small></span>
              <span>Download</span>
            </a>)}
          </div> : <p className="empty-state">Product type JSON files are not generated yet.</p>}
        </div>
      </div>}
    </>
  );
}
