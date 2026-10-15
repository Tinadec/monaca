import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";

/**
 * Contract: docs/contracts/m0.md §2.1. auth-ui is served on its own origin (5174) but every call it
 * makes — reading the interaction, submitting credentials, aborting — goes to the gateway on 8080,
 * so the protocol engine sees one origin and nothing here has to know the server's address.
 */
const PROXIED_PREFIXES = ["/bff", "/oauth2", "/t", "/.well-known", "/v1", "/interaction", "/mcp"];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const gateway = env.VITE_MONACA_GATEWAY_URL || "http://localhost:8080";
  const port = Number(env.MONACA_AUTH_UI_PORT || 5174);

  const proxy = Object.fromEntries(
    PROXIED_PREFIXES.map((prefix) => [prefix, { target: gateway, changeOrigin: true }]),
  );

  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { port, strictPort: true, proxy },
    preview: { port, strictPort: true },
    build: { target: "es2022", sourcemap: true },
  };
});
