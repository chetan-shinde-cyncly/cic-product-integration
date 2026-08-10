import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_PROXY_TARGET || "http://localhost:5100";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": apiTarget,
      },
    },
    build: {
      // OPTIMIZATION: Enable minification and tree-shaking
      minify: "terser",
      terserOptions: {
        compress: {
          drop_console: mode === "production",
          passes: 2,
        },
        output: {
          comments: false,
        },
      },
      // OPTIMIZATION: Better chunk splitting
      rollupOptions: {
        output: {
          manualChunks: {
            // Separate vendor chunks for better caching
            react: ["react", "react-dom"],
          },
        },
      },
      // OPTIMIZATION: Faster builds
      target: "esnext",
      cssCodeSplit: true,
      sourcemap: mode === "development",
      // OPTIMIZATION: Adjust chunk sizes
      chunkSizeWarningLimit: 500,
    },
    // OPTIMIZATION: Cache busting and efficient serving
    preview: {
      headers: {
        "Cache-Control": "public, max-age=3600",
      },
    },
  };
});
