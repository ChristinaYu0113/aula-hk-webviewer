import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.js'],
  outfile: 'viewer.js',
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
});

const licenses = await Promise.all(['three', '@sparkjsdev/spark'].map(async name =>
  `${name}\n${await readFile(`node_modules/${name}/LICENSE`, 'utf8')}`));
await writeFile('third-party-licenses.txt', licenses.join('\n\n'));
