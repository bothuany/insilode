import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The harness flow diagram (every agent-shaping piece placed on the steps of a turn): one inlined JS and CSS file like the canvas.
// It runs after the canvas build, which empties dist-webview, so this one must keep what is there.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-webview',
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, 'src/harness/harness.tsx'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'harness.js',
        assetFileNames: 'harness[extname]',
      },
    },
  },
})
