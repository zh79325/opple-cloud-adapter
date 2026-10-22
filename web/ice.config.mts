import { defineConfig } from '@ice/app';

// The project config, see https://v3.ice.work/docs/guide/basic/config
const minify = process.env.NODE_ENV === 'production' ? 'swc' : false;
export default defineConfig(() => ({
  minify,
  server: {
    onDemand: true,
    format: 'esm',
  },
  // 开发时代理 API 到本地后端（node src/opple/server.js，端口 5170）
  proxy: {
    '/api': {
      target: 'http://localhost:5170',
      changeOrigin: true,
    },
  },
}));
