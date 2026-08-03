import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    // 開發時前端 5173、後端 8080，透過 proxy 走同源，
    // 這樣 httpOnly 的 refresh cookie 才送得出去。
    //
    // 在 docker-compose.hmr.yml 底下跑的時候後端不在 localhost，而是同一個
    // 網路裡的 api:8080 —— 用環境變數指過去，不然整個站會一直 502。
    proxy: {
      '/api': {
        target: process.env.PMFLOW_API_PROXY ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
