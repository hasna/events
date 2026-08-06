import type { ChannelConfig, EventEnvelope, EventFilter, StringMatcher } from "./types.js";
export declare function matchString(value: string | undefined, matcher: StringMatcher | undefined, options?: {
    segmentSafe?: boolean;
}): boolean;
export declare function eventMatchesFilter(event: EventEnvelope, filter: EventFilter): boolean;
export declare function channelMatchesEvent(channel: ChannelConfig, event: EventEnvelope): boolean;
