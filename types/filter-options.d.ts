import type { EventFilter, FieldMatcherValue } from "./types.js";
type MatcherValue = FieldMatcherValue | {
    not: FieldMatcherValue;
};
export interface FilterOptionInput {
    source?: string;
    type?: string;
    subject?: string;
    severity?: string;
    data?: string[];
    metadata?: string[];
    dataJson?: string[];
    metadataJson?: string[];
}
export declare function parseFieldMatchers(values: string[] | undefined, label: string, typed?: boolean): Record<string, MatcherValue> | undefined;
export declare function parseFilterOptions(options: FilterOptionInput): EventFilter[] | undefined;
export {};
