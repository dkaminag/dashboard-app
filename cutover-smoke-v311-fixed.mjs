import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourcePath = path.resolve('cutover-smoke.mjs');
const targetPath = '/tmp/cj-cutover-smoke-v311-fixed.mjs';
const source = await fs.readFile(sourcePath, 'utf8');
const fixed = source.replaceAll('.init()', '.ensure()');
if (fixed === source) throw new Error('CUTOVER_SMOKE_PATCH_NOT_APPLIED');
await fs.writeFile(targetPath, fixed, { mode: 0o600 });
await import(pathToFileURL(targetPath).href + `?fixed=${Date.now()}`);
