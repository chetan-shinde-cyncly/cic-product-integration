# Catalog Integration Client

React client bundled with Webpack.

## Commands

```bash
npm install
npm run dev
npm run build
npm run lint
npm run preview
```

The development and preview servers listen on `http://localhost:5173` and
proxy `/api` requests to `http://localhost:5100` by default.

Set `API_PROXY_TARGET` to change the development proxy destination. Set
`API_DOWNLOAD_BASE` at build time when downloads need a separate API origin.
Production files are emitted to `dist/`.
