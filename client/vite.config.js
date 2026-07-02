import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API + websocket to the Node backend on :4000 so the frontend
// can use relative URLs (/api, /ws) — same as in production behind nginx.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
