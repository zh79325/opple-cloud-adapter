import { defineConfig } from '@ice/app';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The project config, see https://v3.ice.work/docs/guide/basic/config
const minify = process.env.NODE_ENV === 'production' ? 'swc' : false;
// 单进程开发：opple 后端（src/opple/server.js 的 handleRequest）内嵌进 ice dev server，
// 页面与 API 同在 5173 端口，无需再单独启动 npm run web，也不需要 proxy
const serverModuleUrl = pathToFileURL(resolve(process.cwd(), '../src/opple/server.js')).href;

export default defineConfig(() => ({
  minify,
  server: {
    onDemand: true,
    format: 'esm',
  },
  webpack: (config: Record<string, any>) => {
    config.devServer = {
      ...(config.devServer ?? {}),
      // 固定端口：显式指定后 ice 不再自动探测递增，被占用时直接报错，
      // 避免“3000 被占 → 悄悄跑到 3001”造成多个残留 dev server 的困惑
      port: 3000,
      // ice 官方扩展点：把 /api/* 与 /mcp 请求直接交给 opple 后端处理，插到链首优先于页面渲染
      setupMiddlewares: (middlewares: any[]) => {
        let handlerPromise: Promise<any>;
        middlewares.unshift({
          name: 'opple-api',
          middleware: (req: any, res: any, next: () => void) => {
            if (!req.url.startsWith('/api/') && !req.url.startsWith('/mcp')) return next();
            handlerPromise ??= import(serverModuleUrl).then((m: any) => m.handleRequest);
            handlerPromise
              .then((handleRequest: (req: any, res: any) => Promise<void>) => handleRequest(req, res))
              .catch((e: Error) => {
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                }
                res.end(JSON.stringify({ error: e.message }));
              });
          },
        });
        return middlewares;
      },
    };
    return config;
  },
}));
