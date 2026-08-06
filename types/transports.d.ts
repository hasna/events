import type { ChannelConfig, DeliveryAttempt, DeliveryResult, EventEnvelope } from "./types.js";
export interface TransportDispatchOptions {
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    secretResolver?: WebhookSecretResolver;
    now?: () => Date;
}
export type WebhookSecretResolver = (reference: string) => string | undefined | Promise<string | undefined>;
export interface BuildWebhookRequestOptions {
    secret?: string;
    timestamp?: string;
}
export declare function buildWebhookRequest(event: EventEnvelope, channel: ChannelConfig, options?: BuildWebhookRequestOptions): {
    body: string;
    headers: Record<string, string>;
};
export declare function dispatchWebhook(event: EventEnvelope, channel: ChannelConfig, options?: TransportDispatchOptions): Promise<DeliveryAttempt>;
export declare function dispatchCommand(event: EventEnvelope, channel: ChannelConfig): Promise<DeliveryAttempt>;
export declare function dispatchChannel(event: EventEnvelope, channel: ChannelConfig, options?: TransportDispatchOptions): Promise<DeliveryAttempt>;
export declare function createDeliveryResult(event: EventEnvelope, channel: ChannelConfig, attempts: DeliveryAttempt[]): DeliveryResult;
