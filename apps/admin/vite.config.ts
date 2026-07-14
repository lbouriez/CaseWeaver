import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("/node_modules/react-admin/") ||
            id.includes("/node_modules/ra-")
          ) {
            return "react-admin";
          }
          if (
            id.includes("/node_modules/@mui/") ||
            id.includes("/node_modules/@emotion/")
          ) {
            return "mui";
          }
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/react-router")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
