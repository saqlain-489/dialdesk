import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // `--mode demo` (or VITE_DEMO=1) builds the backend-free demo: fictional data, simulated calls.
  const demo = mode === 'demo' || process.env.VITE_DEMO === '1'
  return {
    plugins: [react()],
    define: { __DEMO__: JSON.stringify(demo) },
    // Relative asset paths let the static demo live under a GitHub Pages project path.
    base: demo ? './' : '/',
    server: {
      port: 5174,
      proxy: {
        '/api': 'http://localhost:4001',
      },
    },
    preview: {
      port: 4174,
    },
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
    },
  }
})
