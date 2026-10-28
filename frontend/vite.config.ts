import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Static site: data/*.json is written into public/ by pipeline/checkup.py.
// Relative base so it works under https://<user>.github.io/<repo>/.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
