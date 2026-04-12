import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://192.168.100.186:7777", changeOrigin: true },
      "/wiki": { target: "http://192.168.100.186:7777", changeOrigin: true },
    },
  },
});
