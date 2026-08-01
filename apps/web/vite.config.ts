import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    // 開發時前端 5173、後端 8080，透過 proxy 走同源，
    // 這樣 httpOnly 的 refresh cookie 才送得出去
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
})
