import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // Keep the dashboard's first-paint bundle small: split the three
        // heaviest npm groups into their own chunks so each can be cached
        // independently and they don't bloat index-*.js past Vite's 500 KB
        // soft warning.
        manualChunks: {
          react: ["react", "react-dom"],
          wagmi: ["wagmi", "@tanstack/react-query"],
          viem: ["viem"],
          motion: ["framer-motion"],
        },
      },
    },
  },
});
