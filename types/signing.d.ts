export interface SignatureVerificationOptions {
    toleranceMs?: number;
    now?: number | Date;
}
export declare const DEFAULT_SIGNATURE_TOLERANCE_MS: number;
export declare function buildSignatureBase(timestamp: string, body: string): string;
export declare function signPayload(secret: string, timestamp: string, body: string): string;
export declare function verifyPayloadSignature(secret: string, timestamp: string, body: string, signature: string): boolean;
export declare function isTimestampWithinTolerance(timestamp: string, toleranceMs: number, now?: number | Date): boolean;
export declare function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string, options?: SignatureVerificationOptions): boolean;
