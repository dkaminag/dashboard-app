import http from 'node:http';
const port = Number(process.env.PORT || 3000);
http.createServer((req,res)=>{
  res.statusCode = req.url === '/' ? 200 : 404;
  res.setHeader('content-type','text/plain; charset=utf-8');
  res.end(req.url === '/' ? 'ok' : 'not found');
}).listen(port,'0.0.0.0',()=>{
  console.log(JSON.stringify({event:'v32-verifier-listening',port}));
});
