import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-readable",
    minify: false,
    sourcemap: true,
  },
});
