#!/bin/bash
set -e

echo "🧹 Cleaning build artifacts and cache..."
rm -rf dist
rm -rf node_modules/.cache

echo "📦 Reinstalling dependencies..."
npm ci

echo "🔨 Building with new configuration..."
npm run build

echo "✅ Build complete! Ready to deploy."
echo ""
echo "To deploy to production, run: ./deploy-prod.sh"
