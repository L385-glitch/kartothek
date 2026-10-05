import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built frontend is served by the FastAPI backend at /.
// In dev, proxy /api and /figures to the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8090",
      "/figures": "http://localhost:8090",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
