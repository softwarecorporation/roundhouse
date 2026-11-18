// SPDX-License-Identifier: MPL-2.0
import { build } from 'esbuild';
import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadAndParseConfig } from '@cloudflare/config';
import { cleanBuildOutputDir, getWorkerBundleDir, getWorkerAssetsDir, writeRootConfig, writeWorkerConfig } from '@cloudflare/build-output-utils';

const root = fileURLToPath(new URL('.', import.meta.url));
const buildContext = { isPreview: false, mode: 'production' };
const { result } = await loadAndParseConfig(root + 'cloudflare.config.ts', buildContext);
if (!result.success) throw result.error;
await cleanBuildOutputDir(root);
const bundle = getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['index.js'], outfile: bundle + '/index.js', bundle: true,
  format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'],
  plugins: [{ name: 'wasm-module', setup(build) {
    build.onResolve({ filter: /roundhouse_core_bg\.wasm$/ }, () => ({ path: './roundhouse_core_bg.wasm', external: true }));
  } }] });
await copyFile(root + '../npm/wasm/roundhouse_core_bg.wasm', bundle + '/roundhouse_core_bg.wasm');
const assets = getWorkerAssetsDir(root);
await cp(root + 'public', assets, { recursive: true });
await cp(root + '../examples/reportroom/public', assets + '/reportroom', { recursive: true });
const guide = (await readFile(root + 'README.md', 'utf8')).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile(assets + '/setup.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Setup · Roundhouse</title><link rel="stylesheet" href="/platform.css"></head><body><main class="wrap section"><a href="/">← Roundhouse</a><h1>Setup and boundaries</h1><p><a href="https://github.com/tschk/roundhouse/tree/main/platform">Read the formatted guide and source on GitHub ↗</a></p><pre class="code-block">${guide}</pre></main></body></html>`);
await writeWorkerConfig({ root, config: result.data.worker, manifest: { type: 'complete', mainModule: 'index.js',
  modules: { 'index.js': { type: 'esm' }, 'roundhouse_core_bg.wasm': { type: 'wasm' } } } });
await writeRootConfig({ root, buildContext });
console.log('Roundhouse platform build ready');
