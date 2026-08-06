// @bun
// src/signing.ts
import { createHmac, timingSafeEqual } from "crypto";
var DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
function buildSignatureBase(timestamp, body) {
  return `${timestamp}.${body}`;
}
function signPayload(secret, timestamp, body) {
  const digest = createHmac("sha256", secret).update(buildSignatureBase(timestamp, body)).digest("hex");
  return `sha256=${digest}`;
}
function verifyPayloadSignature(secret, timestamp, body, signature) {
  const expected = signPayload(secret, timestamp, body);
  const actual = signature.trim();
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length)
    return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
function isTimestampWithinTolerance(timestamp, toleranceMs, now = Date.now()) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed))
    return false;
  const reference = now instanceof Date ? now.getTime() : now;
  return Math.abs(reference - parsed) <= toleranceMs;
}
function verifyWebhookSignature(secret, timestamp, body, signature, options = {}) {
  const toleranceMs = options.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  if (!isTimestampWithinTolerance(timestamp, toleranceMs, options.now)) {
    return false;
  }
  return verifyPayloadSignature(secret, timestamp, body, signature);
}
export {
  verifyWebhookSignature,
  verifyPayloadSignature,
  signPayload,
  isTimestampWithinTolerance,
  buildSignatureBase,
  DEFAULT_SIGNATURE_TOLERANCE_MS
};
