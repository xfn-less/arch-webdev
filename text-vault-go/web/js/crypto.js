import {fromBase64, text, toBase64, utf8} from "./codec.js";

const KDF_ITERATIONS = 600_000;
const WRAP_AAD = utf8("text-vault:v1:data-key");

export async function createVault(password) {
  validateNewPassword(password);
  const generated = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, true, ["encrypt", "decrypt"]);
  const rawDataKey = new Uint8Array(await crypto.subtle.exportKey("raw", generated));
  const key = await importDataKey(rawDataKey);
  try {
    return {...await wrapRawDataKey(password, rawDataKey), key};
  } finally {
    rawDataKey.fill(0);
  }
}

// Password changes rotate only the wrapper and authentication credential.
// Entry ciphertext remains valid because its random data key is unchanged.
export async function rewrapVault(password, key) {
  validateNewPassword(password);
  const rawDataKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    return await wrapRawDataKey(password, rawDataKey);
  } finally {
    rawDataKey.fill(0);
  }
}

export async function unlockVault(password, header) {
  validatePassword(password);
  validateHeader(header);
  const wrappingKey = await deriveWrappingKey(password, fromBase64(header.kdf.salt), header.kdf.iterations);
  const raw = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: fromBase64(header.wrap.iv),
    additionalData: WRAP_AAD,
  }, wrappingKey, fromBase64(header.wrap.ciphertext)));
  try {
    return await importDataKey(raw);
  } finally {
    raw.fill(0);
  }
}

export async function deriveVaultAccess(password, header) {
  const [key, credential] = await Promise.all([
    unlockVault(password, header),
    deriveServerCredential(password, header),
  ]);
  return {key, credential};
}

// Authentication uses a separately salted derivative. Sending this value to
// Go proves knowledge of the password without exposing the data-wrapping key.
export async function deriveServerCredential(password, header) {
  validatePassword(password);
  validateHeader(header);
  return deriveCredential(password, fromBase64(header.auth.salt), header.auth.iterations);
}

async function deriveCredential(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name: "PBKDF2", salt, iterations, hash: "SHA-256"}, material, 256);
  return toBase64(bits).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function wrapRawDataKey(password, rawDataKey) {
  const salt = randomBytes(16);
  const authSalt = randomBytes(16);
  const iv = randomBytes(12);
  const [wrappingKey, credential] = await Promise.all([
    deriveWrappingKey(password, salt, KDF_ITERATIONS),
    deriveCredential(password, authSalt, KDF_ITERATIONS),
  ]);
  const wrapped = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: WRAP_AAD}, wrappingKey, rawDataKey);
  return {
    header: {
      schemaVersion: 1,
      kdf: {name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: toBase64(salt)},
      auth: {name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: toBase64(authSalt)},
      wrap: {name: "AES-GCM", iv: toBase64(iv), ciphertext: toBase64(wrapped)},
    },
    credential,
  };
}

export async function encryptObject(key, metadata, value) {
  const iv = randomBytes(12);
  const plaintext = utf8(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: metadataAAD(metadata),
  }, key, plaintext);
  plaintext.fill(0);
  return {schemaVersion: 1, algorithm: "AES-GCM", iv: toBase64(iv), ciphertext: toBase64(ciphertext)};
}

export async function decryptObject(key, metadata, envelope) {
  validateEnvelope(envelope);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: fromBase64(envelope.iv),
    additionalData: metadataAAD(metadata),
  }, key, fromBase64(envelope.ciphertext));
  const value = JSON.parse(text(plaintext));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("decrypted object must be a JSON object");
  }
  return value;
}

async function deriveWrappingKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name: "PBKDF2", salt, iterations, hash: "SHA-256"},
    material,
    {name: "AES-GCM", length: 256},
    false,
    ["encrypt", "decrypt"],
  );
}

function importDataKey(raw) {
  if (raw.byteLength !== 32) throw new TypeError("invalid data key length");
  return crypto.subtle.importKey("raw", raw, {name: "AES-GCM"}, true, ["encrypt", "decrypt"]);
}

function metadataAAD(metadata) {
  if (!metadata || typeof metadata.id !== "string" || typeof metadata.kind !== "string" || !Number.isSafeInteger(metadata.revision)) {
    throw new TypeError("invalid object metadata");
  }
  return utf8(JSON.stringify({schemaVersion: 1, id: metadata.id, kind: metadata.kind, revision: metadata.revision}));
}

function validateHeader(header) {
  if (header?.schemaVersion !== 1 || header.kdf?.name !== "PBKDF2" || header.kdf?.hash !== "SHA-256" ||
      !Number.isSafeInteger(header.kdf?.iterations) || header.kdf.iterations < KDF_ITERATIONS ||
      header.auth?.name !== "PBKDF2" || header.auth?.hash !== "SHA-256" ||
      !Number.isSafeInteger(header.auth?.iterations) || header.auth.iterations < KDF_ITERATIONS ||
      header.wrap?.name !== "AES-GCM") {
    throw new TypeError("unsupported vault header");
  }
  if (fromBase64(header.kdf.salt).byteLength !== 16 || fromBase64(header.auth.salt).byteLength !== 16 || fromBase64(header.wrap.iv).byteLength !== 12) {
    throw new TypeError("invalid vault header lengths");
  }
  fromBase64(header.wrap.ciphertext);
}

function validateEnvelope(envelope) {
  if (envelope?.schemaVersion !== 1 || envelope.algorithm !== "AES-GCM" || fromBase64(envelope.iv).byteLength !== 12) {
    throw new TypeError("unsupported object envelope");
  }
  fromBase64(envelope.ciphertext);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12) throw new TypeError("password must contain at least 12 characters");
}

function validateNewPassword(password) {
  if (typeof password !== "string" || password.length < 16) throw new TypeError("password must contain at least 16 characters");
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}
