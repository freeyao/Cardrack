import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2020', outDir: 'dist' },
  test: { environment: 'node', globals: false },
});
