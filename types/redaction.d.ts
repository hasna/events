import type { EventEnvelope } from "./types.js";
export declare function redactPaths<T extends EventEnvelope>(event: T, paths: string[], replacement?: string): T;
export declare function redactSensitiveKeys<T extends EventEnvelope>(event: T, replacement?: string): T;
export declare function shouldRedactKey(key: string): boolean;
