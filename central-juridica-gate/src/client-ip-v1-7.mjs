import net from 'node:net';

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return null;
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const zone = ip.indexOf('%'); if (zone > 0) ip = ip.slice(0, zone);
  return net.isIP(ip) ? ip.toLowerCase() : null;
}
function ipv4Bytes(ip){return Buffer.from(ip.split('.').map(Number));}
function ipv6Bytes(ip){const [lraw,rraw='']=ip.split('::');const l=lraw?lraw.split(':').filter(Boolean):[];const r=rraw?rraw.split(':').filter(Boolean):[];const missing=8-l.length-r.length;if(missing<0||(!ip.includes('::')&&missing!==0))throw new Error('IPv6 inválido');const groups=[...l,...Array(missing).fill('0'),...r];const out=Buffer.alloc(16);groups.forEach((g,i)=>out.writeUInt16BE(parseInt(g||'0',16),i*2));return out;}
function bytes(ip){const v=net.isIP(ip);return v===4?{v,b:ipv4Bytes(ip)}:v===6?{v,b:ipv6Bytes(ip)}:null;}
function cidrMatch(ip,cidr){const [baseRaw,bitsRaw]=String(cidr).split('/');const base=normalizeIp(baseRaw),target=normalizeIp(ip);if(!base||!target)return false;const a=bytes(base),b=bytes(target);if(!a||!b||a.v!==b.v)return false;const max=a.b.length*8,bits=bitsRaw===undefined?max:Number(bitsRaw);if(!Number.isInteger(bits)||bits<0||bits>max)throw new Error('CIDR inválido');const whole=Math.floor(bits/8),rem=bits%8;for(let i=0;i<whole;i++)if(a.b[i]!==b.b[i])return false;if(!rem)return true;const mask=(0xff<<(8-rem))&0xff;return (a.b[whole]&mask)===(b.b[whole]&mask);}
export function resolveClientIp(peerRaw, xffRaw, trusted=[]) {const peer=normalizeIp(peerRaw)||'unknown';if(peer==='unknown'||!trusted.some(spec=>cidrMatch(peer,spec)))return peer;if(!xffRaw)return peer;const forwarded=String(xffRaw).split(',').map(v=>normalizeIp(v.trim()));if(!forwarded.length||forwarded.some(v=>!v))return peer;const chain=[...forwarded,peer];for(let i=chain.length-1;i>=0;i--)if(!trusted.some(spec=>cidrMatch(chain[i],spec)))return chain[i];return chain[0];}
