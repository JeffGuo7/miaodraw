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
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // 探针独立 entry → 产出 out/main/probes/shot.js，与生产入口分离：
          // index.ts 里用动态 import('./probes/shot') 加载，生产运行路径不会加载该 chunk
          'probes/shot': resolve(__dirname, 'src/main/probes/shot.ts')
        }
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
