FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY index.js process-json.js ./
COPY db ./db
COPY helpers ./helpers
COPY repositories ./repositories
COPY routes ./routes
COPY scheduler ./scheduler
COPY services ./services
COPY scripts ./scripts
RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/catalogs && chown -R app:app /app
USER app
EXPOSE 5100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "index.js"]
