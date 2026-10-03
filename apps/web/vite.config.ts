import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const developmentProxy: ProxyOptions = {
  target: 'http://localhost:3000',
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (request, incoming) => {
      if (incoming.headers.origin) request.setHeader('Origin', 'http://localhost:3000');
    });
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': developmentProxy, '/mcp': developmentProxy, '/openapi.json': developmentProxy } },
  build: { outDir: 'dist', sourcemap: true },
});
