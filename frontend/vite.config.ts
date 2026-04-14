import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:8000";
  return {
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
        "/api": { target: proxyTarget, changeOrigin: true },
        "/wiki": { target: proxyTarget, changeOrigin: true },
      },
    },
  };
});
