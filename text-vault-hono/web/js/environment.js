const secureContextMessage = "Text Vault 需要 HTTPS 或 localhost 才能使用浏览器加密。";

// Encryption is a startup requirement, not a feature that can fail halfway
// through loading. Keeping this check pure also makes the HTTP failure path
// testable without starting a browser.
export function checkEnvironment(environment) {
  if (!environment.isSecureContext || !environment.crypto?.subtle) {
    return {ok: false, message: secureContextMessage};
  }
  return {ok: true};
}
