import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        sidepanel: resolve(__dirname, "src/sidepanel/index.html"),
        options: resolve(__dirname, "src/options/index.html"),
      },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name][extname]" },
    },
  },
});
