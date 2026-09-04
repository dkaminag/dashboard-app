import http from 'node:http';
import handler from './runtime/src/server.mjs';

process.env.CJ_SERVE_STATIC_FROM_FUNCTION ??= 'true';
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const server = http.createServer((req,res)=>handler(req,res));
server.listen(port, host, () => {
  console.log(JSON.stringify({level:'info',event:'server-listening',host,port,version:'3.0.0'}));
});
for (const signal of ['SIGTERM','SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
