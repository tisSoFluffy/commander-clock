import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host: true makes Vite bind to 0.0.0.0 so other devices on your
// wifi (phones) can reach the laptop's IP. Without this, only the
// laptop itself can open the app.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
});
