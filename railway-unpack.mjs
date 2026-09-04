import fs from 'node:fs/promises';
import zlib from 'node:zlib';
const dir=new URL('./',import.meta.url);
let encoded='';
for(let i=0;i<8;i++) encoded+=(await fs.readFile(new URL(`runtime.bundle.${String(i).padStart(2,'0')}.b64`,dir),'utf8')).trim();
const raw=zlib.gunzipSync(Buffer.from(encoded,'base64')).toString('utf8');
const files=JSON.parse(raw);
const runtimeRoot=new URL('./runtime/',import.meta.url);
await fs.rm(runtimeRoot,{recursive:true,force:true});
await fs.mkdir(runtimeRoot,{recursive:true});
for(const [relative,content] of Object.entries(files)){
  if(!(relative==='package.json'||/^(src|public|data)\//.test(relative))||relative.includes('..')) throw new Error(`Caminho de bundle inválido: ${relative}`);
  const target=new URL(relative,runtimeRoot);
  await fs.mkdir(new URL('./',target),{recursive:true});
  await fs.writeFile(target,content,'utf8');
}
console.log(JSON.stringify({event:'runtime-bundle-unpacked',files:Object.keys(files).length}));
