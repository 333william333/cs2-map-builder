// Bundles server/index.ts to server-dist/server.mjs (plain JS, express etc. inlined).
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'server-dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  // some CJS deps inside express use require(); give the ESM bundle a require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('server-dist/server.mjs ready');
