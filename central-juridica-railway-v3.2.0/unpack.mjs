import fs from 'node:fs/promises';
import zlib from 'node:zlib';

async function readEncodedBundle() {
  try { return (await fs.readFile(new URL('./runtime.bundle.b64', import.meta.url), 'utf8')).trim(); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const dir = new URL('./', import.meta.url);
  const names = (await fs.readdir(dir)).filter(name => /^runtime\.bundle\.part\d+\.b64$/.test(name)).sort();
  if (!names.length) throw new Error('Runtime bundle ausente.');
  return (await Promise.all(names.map(name => fs.readFile(new URL(name, dir), 'utf8')))).join('').replace(/\s+/g, '');
}

const encoded = await readEncodedBundle();
const raw = zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
const files = JSON.parse(raw);
const runtimeRoot = new URL('./runtime/', import.meta.url);
await fs.rm(runtimeRoot, { recursive: true, force: true });
await fs.mkdir(runtimeRoot, { recursive: true });
for (const [relative, content] of Object.entries(files)) {
  if (!(relative === 'package.json' || /^(src|public|data|contracts)\//.test(relative)) || relative.includes('..')) throw new Error(`Caminho de bundle inválido: ${relative}`);
  const target = new URL(relative, runtimeRoot);
  await fs.mkdir(new URL('./', target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}
const pkg = JSON.parse(await fs.readFile(new URL('./runtime/package.json', import.meta.url), 'utf8'));
if (pkg.version !== '3.1.1') throw new Error(`Versão inesperada no bundle: ${pkg.version}`);
console.log(JSON.stringify({ event: 'runtime-bundle-unpacked', files: Object.keys(files).length, version: pkg.version }));
