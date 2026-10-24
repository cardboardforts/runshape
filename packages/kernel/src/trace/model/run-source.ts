import { Run } from "./trace";

/** Port: where recorded runs come from. The domain asks for runs; how they're stored is the adapter's. */
export interface RunSource {
  latest(): Promise<Run>;
  /** The run to compare against; null when there is none. */
  previous(): Promise<Run | null>;
}
