// What a component holds, as a recording saw it: its functions, their coverage and time. The
// visualizer builds it (buildComponentView); zone advice reads it; the UI shows it.
import type { FunctionRef } from "./function-ref";

/** One box from the system graph opened up: its functions and how much the tests reach. */
export interface ComponentView {
  id: string;
  label: string;
  qualifiedName: string | null;
  functions: FunctionSummary[];
}

export interface FunctionSummary {
  symbol: FunctionRef;
  name: string;
  file: string;
  firstLine: number;
  /** Set when the method is defined on a base class but ran on this component's objects. */
  inheritedFrom: string | null;
  executableLines: number;
  coveredLines: number;
  calls: number;
  /** Wall time over all its calls, inclusive; a recursive call inside another isn't counted again. */
  totalUs: number;
  /** totalUs minus the project code it called: its own lines, plus library and database time. */
  selfUs: number;
  scenarioIds: string[];
}
