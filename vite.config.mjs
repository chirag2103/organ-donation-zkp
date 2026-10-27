import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const apiUrl = env.VITE_API_URL || `http://127.0.0.1:${env.PORT || 3001}`;
  return {
    plugins: [react()],
    root: "src",
    server: {
      host: "127.0.0.1",
      port: 5173,
      fs: { allow: [".."] },
      proxy: { "/api": { target: apiUrl, changeOrigin: true } },
    },
    build: { outDir: "../dist", emptyOutDir: true },
    worker: { format: "es" },
  };
});
