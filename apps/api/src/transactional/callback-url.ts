import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/**
 * Erro de validação de URL de callback (anti-SSRF). Mapeado para 400 no dispatch
 * e para "skip" no envio. Não estende exceções do Nest para permanecer um helper
 * puro e testável.
 */
export class CallbackUrlError extends Error {}

export interface SafeCallbackTarget {
  url: URL;
  /** IP resolvido e validado — usado para "pinar" a conexão (anti-rebinding). */
  address: string;
  family: 4 | 6;
}

/**
 * Valida a URL de callback contra SSRF e devolve o IP público resolvido para
 * pinar a conexão. Regras (fail-closed):
 * - protocolo https, sem userinfo, porta vazia ou 443;
 * - host literal (IPv4/IPv6, formas decimais/octais são normalizadas pelo URL
 *   parser) ou hostname resolvido via DNS;
 * - TODOS os IPs resolvidos precisam ser públicos (rejeita loopback, privados,
 *   link-local, ULA, CGNAT, multicast, reservados, IPv4-mapeados em IPv6).
 *
 * O IP retornado deve ser usado no connect (com SNI/Host = hostname) para que a
 * verificação e o connect usem o MESMO endereço (mitiga DNS-rebinding).
 */
export const assertSafeCallbackUrl = async (rawUrl: string): Promise<SafeCallbackTarget> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CallbackUrlError('callbackUrl inválida');
  }

  if (url.protocol !== 'https:') {
    throw new CallbackUrlError('callbackUrl deve usar https');
  }
  if (url.username || url.password) {
    throw new CallbackUrlError('callbackUrl não pode conter credenciais');
  }
  if (url.port && url.port !== '443') {
    throw new CallbackUrlError('callbackUrl deve usar a porta 443');
  }

  // O URL parser normaliza IPv4 em formas decimal/octal/hex para dotted-decimal
  // e IPv6 entre colchetes; então basta testar o hostname canônico.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

  if (isIP(host)) {
    assertPublicIp(host);
    return { url, address: host, family: isIP(host) === 6 ? 6 : 4 };
  }

  const resolved = await lookup(host, { all: true }).catch(() => []);
  if (resolved.length === 0) {
    throw new CallbackUrlError('callbackUrl não resolvível');
  }
  for (const entry of resolved) {
    assertPublicIp(entry.address);
  }

  const pinned = resolved[0];
  return { url, address: pinned.address, family: pinned.family === 6 ? 6 : 4 };
};

/**
 * POST JSON "pinado": conecta ao IP já validado (não re-resolve), com SNI e
 * header Host = hostname original, e NÃO segue redirecionos. Devolve o status
 * HTTP como string. Lança em erro de rede/timeout.
 */
export const postJsonToSafeTarget = (
  target: SafeCallbackTarget,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: target.address,
        servername: target.url.hostname, // SNI + validação de certificado pelo hostname
        port: 443,
        method: 'POST',
        path: `${target.url.pathname}${target.url.search}`,
        headers: {
          ...headers,
          Host: target.url.host,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        // rejectUnauthorized default = true (valida cert TLS contra servername).
      },
      (res) => {
        // Não seguimos redirecionos (anti-SSRF): apenas registramos o status.
        res.resume();
        resolve(String(res.statusCode ?? 0));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('callback timeout')));
    req.on('error', reject);
    req.end(body);
  });

const assertPublicIp = (address: string): void => {
  const bytes = ipBytes(address);
  if (!bytes || !isPublicUnicast(bytes)) {
    throw new CallbackUrlError('callbackUrl aponta para IP não público');
  }
};

/**
 * Endereço (IPv4 ou IPv6, já normalizado por `isIP`) -> bytes (4 ou 16).
 * IPv6 comprimido (`::`) é expandido e IPv4 embutido (pontilhado) é reduzido a
 * hextets. Retorna null se não for um IP válido.
 */
export const ipBytes = (address: string): number[] | null => {
  const family = isIP(address);
  if (family === 4) {
    return parseIpv4Octets(address);
  }
  if (family === 6) {
    return expandIpv6ToBytes(address);
  }
  return null;
};

/**
 * Classifica os bytes: público (unicast global roteável) ou não. Reduz IPv6 com
 * IPv4 embutido (mapeado `::ffff:0:0/96`, compat `::/96`, NAT64 `64:ff9b::/96`)
 * a 4 octetos e reaproveita a checagem IPv4; para IPv6 nativo testa faixas
 * especiais em BYTES (não por prefixo de string).
 */
export const isPublicUnicast = (bytes: number[]): boolean => {
  if (bytes.length === 4) {
    return !isPrivateIpv4Bytes(bytes);
  }
  if (bytes.length !== 16) {
    return false;
  }

  const embedded = embeddedIpv4(bytes);
  if (embedded) {
    return !isPrivateIpv4Bytes(embedded);
  }

  const [b0, b1, b2, b3] = bytes;
  // loopback ::1 e unspecified :: já são cobertos por embeddedIpv4 (prefixo
  // ::/96 => octetos 0.0.0.0 e 0.0.0.1, ambos privados). Faixas IPv6 nativas:
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return false; // link-local fe80::/10
  if ((b0 & 0xfe) === 0xfc) return false; // ULA fc00::/7 (fc/fd)
  if (b0 === 0xff) return false; // multicast ff00::/8
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return false; // 2001:db8::/32
  return true;
};

/** Se os bytes IPv6 embutem um IPv4, devolve os 4 octetos; senão null. */
const embeddedIpv4 = (bytes: number[]): number[] | null => {
  const mappedOrCompat =
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0 &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    // ::ffff:0:0/96 (mapeado) OU ::/96 (compat/loopback/unspecified)
    ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0));
  // NAT64 64:ff9b::/96
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0 &&
    bytes[11] === 0;
  if (mappedOrCompat || nat64) {
    return [bytes[12], bytes[13], bytes[14], bytes[15]];
  }
  return null;
};

const parseIpv4Octets = (ip: string): number[] | null => {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
};

const expandIpv6ToBytes = (input: string): number[] | null => {
  let addr = input;
  const zone = addr.indexOf('%');
  if (zone >= 0) {
    addr = addr.slice(0, zone);
  }

  // IPv4 embutido pontilhado (ex.: ::ffff:127.0.0.1) -> dois hextets hex.
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon < 0) {
      return null;
    }
    const octets = parseIpv4Octets(addr.slice(lastColon + 1));
    if (!octets) {
      return null;
    }
    const g1 = ((octets[0] << 8) | octets[1]).toString(16);
    const g2 = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${g1}:${g2}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];

  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) {
      return null;
    }
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) {
    return null;
  }

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null;
    }
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
};

const isPrivateIpv4Bytes = (bytes: number[]): boolean => {
  const [a, b] = bytes;
  if (a === 0) return true; // 0.0.0.0/8 (inclui unspecified)
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback 127/8
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 (benchmark)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast 224/4 + reservado 240/4 + 255...
  return false;
};
