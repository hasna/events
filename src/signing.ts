import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureVerificationOptions {
  toleranceMs?: number;
  now?: number | Date;
}

export const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export function buildSignatureBase(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret).update(buildSignatureBase(timestamp, body)).digest("hex");
  return `sha256=${digest}`;
}

export function verifyPayloadSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = signPayload(secret, timestamp, body);
  const actual = signature.trim();
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function isTimestampWithinTolerance(timestamp: string, toleranceMs: number, now: number | Date = Date.now()): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const reference = now instanceof Date ? now.getTime() : now;
  return Math.abs(reference - parsed) <= toleranceMs;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  options: SignatureVerificationOptions = {},
): boolean {
  const toleranceMs = options.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  if (!isTimestampWithinTolerance(timestamp, toleranceMs, options.now)) {
    return false;
  }
  return verifyPayloadSignature(secret, timestamp, body, signature);
}
