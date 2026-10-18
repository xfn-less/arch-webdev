// Provisioning data stays inside the encrypted text entry. Never navigate to
// otpauth URLs or send their contents to a remote generator.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const algorithms = {'SHA1': 'SHA-1', 'SHA256': 'SHA-256', 'SHA512': 'SHA-512'};

function decodeSecret(value) {
  const secret = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(secret)) throw new Error('密钥需要是有效的 Base32 字符串');
  const raw = secret.replace(/=+$/, '');
  if (![0, 2, 4, 5, 7].includes(raw.length % 8) ||
      (secret.includes('=') && secret.length % 8 !== 0)) throw new Error('密钥长度不完整');
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const char of raw) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (!bytes.length || buffer !== 0) throw new Error('密钥编码无效');
  return {secret: raw, bytes: new Uint8Array(bytes)};
}

export function parseTotpEntry(text) {
  const lines = text.split(/\r?\n/);
  const marked = lines.filter(line => /^\s*(?:totp\s*:|otpauth:\/\/)/i.test(line));
  if (!marked.length) return null;
  try {
    if (marked.length !== 1) throw new Error('每条记录只能保存一个 2FA 密钥');
    let value = marked[0].trim().replace(/^totp\s*:\s*/i, '');
    let algorithm = 'SHA-1', digits = 6, period = 30;
    if (/^otpauth:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.hostname !== 'totp' || url.username || url.password || url.port || url.hash) throw new Error('仅支持 TOTP 配置链接');
      for (const name of ['secret', 'algorithm', 'digits', 'period']) {
        if (url.searchParams.getAll(name).length > 1) throw new Error('配置链接包含重复参数');
      }
      algorithm = algorithms[(url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()];
      const size = url.searchParams.get('digits') ?? '6';
      const step = url.searchParams.get('period') ?? '30';
      if (!algorithm || !/^[68]$/.test(size) || !/^[1-9]\d*$/.test(step) || !Number.isSafeInteger(Number(step))) {
        throw new Error('请使用 SHA1/SHA256/SHA512、6 或 8 位和正整数周期');
      }
      digits = Number(size); period = Number(step);
      value = url.searchParams.get('secret') ?? '';
    }
    const {secret} = decodeSecret(value);
    return {config: {secret, algorithm, digits, period}};
  } catch (error) {
    // URL parser exceptions can contain the secret; expose only our own errors.
    return {error: error instanceof TypeError || error instanceof URIError ? '2FA 配置链接无效' : error.message};
  }
}

export async function generateTotp(config, milliseconds = Date.now()) {
  const {secret, algorithm, digits, period} = config;
  if (!Object.values(algorithms).includes(algorithm) || ![6, 8].includes(digits) ||
      !Number.isSafeInteger(period) || period <= 0 || !Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError('invalid TOTP parameters');
  }
  const counter = Math.floor(milliseconds / 1000 / period);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', decodeSecret(secret).bytes,
    {name: 'HMAC', hash: algorithm}, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1] & 15;
  const binary = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return {
    code: String(binary % 10 ** digits).padStart(digits, '0'),
    remaining: period - Math.floor(milliseconds / 1000) % period,
    counter,
  };
}
