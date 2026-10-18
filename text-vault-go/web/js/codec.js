const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {fatal: true});

export const utf8 = value => encoder.encode(value);
export const text = value => decoder.decode(value);

export function toBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("invalid base64");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
