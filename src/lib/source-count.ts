import { discoveredStreams, loadRegistry } from "./source-discovery.js";
import { SOURCE_STREAMS, type SourceStream } from "./source-streams.js";

export type SourceCounts = { sources: number; publishers: number };

/** How many streams collection reads and how many publishers own them. */
export function countSources(streams: readonly Pick<SourceStream, "publisherId">[]): SourceCounts {
  return { sources: streams.length, publishers: new Set(streams.map((stream) => stream.publisherId)).size };
}

/** The same set collection runs on: the audited catalog plus every discovered publisher on probation or active. */
export async function currentSourceCounts(): Promise<SourceCounts> {
  return countSources([...SOURCE_STREAMS, ...discoveredStreams(await loadRegistry())]);
}
