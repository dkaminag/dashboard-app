import net from 'node:net';

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return null;
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  // Node exposes IPv4 peers as IPv4-mapped IPv6 on some platforms.
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function ipv4Bytes(ip) { return Buffer.from(ip.split('.').map(Number)); }
function ipv6Bytes(ip) {
  const mapped = ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4;
  if (mapped) return Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), ipv4Bytes(ip.slice(7))]);
  const [leftRaw, rightRaw = ''] = ip.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const expandEmbeddedV4 = parts => parts.flatMap(part => {
    if (!part.includes('.')) return [part];
    const b = ipv4Bytes(part); return [((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)];
  });
  const l = expandEmbeddedV4(left), r = expandEmbeddedV4(right);
  const missing = 8 - l.length - r.length;
  if (missing < 0 || (!ip.includes('::') && missing !== 0)) throw new Error(`IPv6 inválido: ${ip}`);
  const groups = [...l, ...Array(missing).fill('0'), ...r];
  const out = Buffer.alloc(16);
  groups.forEach((group, i) => out.writeUInt16BE(parseInt(group || '0', 16), i * 2));
  return out;
}

function ipBytes(ip) {
  const version = net.isIP(ip);
  if (version === 4) return { version, bytes: ipv4Bytes(ip) };
  if (version === 6) return { version, bytes: ipv6Bytes(ip) };
  return null;
}

function cidrMatch(ip, cidr) {
  const [baseRaw, bitsRaw] = String(cidr).split('/');
  const base = normalizeIp(baseRaw); const target = normalizeIp(ip);
  if (!base || !target) return false;
  const a = ipBytes(base), b = ipBytes(target);
  if (!a || !b || a.version !== b.version) return false;
  const maxBits = a.bytes.length * 8;
  const bits = bitsRaw === undefined ? maxBits : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) throw new Error(`CIDR inválido: ${cidr}`);
  const whole = Math.floor(bits / 8), rem = bits % 8;
  for (let i = 0; i < whole; i += 1) if (a.bytes[i] !== b.bytes[i]) return false;
  if (!rem) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (a.bytes[whole] & mask) === (b.bytes[whole] & mask);
}

export function parseTrustedProxies(value = process.env.CJ_TRUST_PROXY) {
  const specs = String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  // Validate at startup so a typo never silently widens trust.
  for (const spec of specs) {
    const [base, bits] = spec.split('/');
    const normalized = normalizeIp(base);
    if (!normalized) throw new Error(`CJ_TRUST_PROXY contém IP/CIDR inválido: ${spec}`);
    const max = net.isIP(normalized) === 4 ? 32 : 128;
    if (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) < 0 || Number(bits) > max)) throw new Error(`CJ_TRUST_PROXY contém CIDR inválido: ${spec}`);
  }
  return specs;
}

export function isTrustedProxy(ip, trusted = []) {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  return trusted.some(spec => cidrMatch(normalized, spec));
}

export function resolveClientIp(req, trusted = []) {
  const peer = normalizeIp(req?.socket?.remoteAddress) || 'unknown';
  if (peer === 'unknown' || !trusted.length || !isTrustedProxy(peer, trusted)) return peer;
  const raw = req?.headers?.['x-forwarded-for'];
  if (!raw) return peer;
  const forwarded = String(raw).split(',').map(v => normalizeIp(v.trim()));
  // Malformed forwarding metadata is ignored entirely rather than partially trusted.
  if (!forwarded.length || forwarded.some(v => !v)) return peer;
  const chain = [...forwarded, peer];
  for (let i = chain.length - 1; i >= 0; i -= 1) if (!isTrustedProxy(chain[i], trusted)) return chain[i];
  return chain[0];
}

export { normalizeIp, cidrMatch };
