import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // hidden sourcemap：产物无 .map 引用，map 单独归档排障，不进安装包
      sourcemap: 'hidden',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react()],
    build: {
      // electron-vite 默认 minify:false —— 显式开启压缩并产出隐藏 sourcemap
      minify: 'esbuild',
      sourcemap: 'hidden',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
