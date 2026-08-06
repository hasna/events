#!/usr/bin/env bun
export interface RunEventsCliOptions {
    programName?: string;
    source?: string;
}
export declare function runEventsCli(argv?: string[], options?: RunEventsCliOptions): Promise<void>;
