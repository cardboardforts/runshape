# Algorithms and data structures

For an instance, parts are usually line ranges or small helpers. The **See it** visualizations that
animate data need values from a recording; until then they can be drawn as a template with the
tagged parts highlighted.

### `dsa-sliding-window`: Sliding Window
**What:** Keeps a running result over a contiguous range that moves across a sequence, updating incrementally rather than recomputing.  
**Parts:** `window`, `expand`, `shrink`, `aggregate`, `emit`  
**Invariants:** The left edge never passes the right. Each element enters once and leaves once, so the work is O(n). The aggregate always matches the window's contents.  
**Bugs:** Off by one on shrink; the aggregate not updated when an element leaves; emitting before the window is full; an empty window.  
**Look-alikes:** `dsa-two-pointers` may move the ends toward each other, with no running aggregate. `dsa-prefix-sum` answers fixed ranges with no moving state.  
**See it:** The sequence with the window's edges moving across it and the aggregate beside it.  
**With:** `dist-rate-limiter`  

### `dsa-two-pointers`: Two Pointers
**What:** Two indexes move through a sequence, often from both ends, ruling out cases as they go.  
**Parts:** `left`, `right`, `move-rule`  
**Invariants:** Each step rules something out, so the loop ends.  
**Bugs:** Unsorted input where sorted is assumed; a loop that doesn't always move.  
**See it:** Two markers over the sequence.  

### `dsa-binary-search`: Binary Search
**What:** Halves a sorted range or a monotonic answer space each step.  
**Parts:** `low`, `high`, `mid`, `predicate`  
**Invariants:** The answer stays inside the range. The range shrinks each step. The predicate is monotonic.  
**Bugs:** Off by one at the bounds; overflow computing mid; an infinite loop on two elements.  
**See it:** The range narrowing.  

### `dsa-prefix-sum`: Prefix Sum
**What:** Precomputes running totals so any range's total is one subtraction.  
**Parts:** `prefix-table`, `range-query`  
**Invariants:** The table matches the data: an update invalidates it.  
**Bugs:** Off by one at index zero; a stale table.  
**See it:** The sequence with its running total below.  

### `dsa-bfs`: Breadth-First Search
**What:** Explores a graph level by level with a queue. Finds shortest paths in unweighted graphs.  
**Parts:** `frontier`, `visited`, `expand`  
**Invariants:** Each node is visited once. Nodes come out in order of distance.  
**Bugs:** Marking visited on removal rather than on adding, which queues duplicates.  
**See it:** A wave spreading over the graph.  

### `dsa-dfs`: Depth-First Search
**What:** Explores a graph as deep as it can, then backs up.  
**Parts:** `stack`, `visited`, `visit`  
**Invariants:** Each node is visited once.  
**Bugs:** Recursion depth on large input; missing the visited check on a cyclic graph.  
**See it:** One path extending and backing up.  

### `dsa-topological-sort`: Topological Sort
**What:** Orders a dependency graph so each thing comes after what it needs.  
**Parts:** `in-degree`, `ready-queue`, `order`  
**Invariants:** Cycles are detected and reported.  
**Bugs:** A cycle silently dropping nodes.  
**See it:** The graph flattened into layers.  

### `dsa-shortest-path`: Shortest Path (Dijkstra)
**What:** Settles nodes in order of distance using a priority queue.  
**Parts:** `distances`, `priority-queue`, `relax`  
**Invariants:** Weights aren't negative. A settled node doesn't change.  
**Bugs:** Negative weights; stale queue entries.  
**See it:** The settled region growing outward.  

### `dsa-dynamic-programming`: Dynamic Programming
**What:** Solves a problem from overlapping subproblems, storing each answer.  
**Parts:** `state`, `transition`, `base-case`, `table`  
**Invariants:** Each state depends only on states already solved.  
**Bugs:** A state that leaves out something that matters; wrong fill order; memory growing with the table.  
**See it:** The table filling in, with dependency arrows.  

### `dsa-memoization`: Memoization
**What:** Caches a pure function's results by its arguments.  
**Parts:** `key`, `cache`, `compute`  
**Invariants:** The function is pure, and the key covers every input.  
**Bugs:** A key that misses an input; caching across users; no bound on size.  
**See it:** Calls with hits and misses marked.  
**With:** `pure`  

### `dsa-backtracking`: Backtracking
**What:** Builds a solution one choice at a time and undoes choices that fail.  
**Parts:** `choice`, `constraint`, `undo`  
**Invariants:** Every choice is undone on the way back.  
**Bugs:** State left behind after undo; exploring far more than expected.  
**See it:** A search tree with pruned branches.  

### `dsa-greedy`: Greedy
**What:** Takes the best local choice at each step and never revisits it.  
**Parts:** `ordering`, `choice`  
**Invariants:** There's a reason local choices lead to the best overall answer.  
**Bugs:** Using it where that reason doesn't hold.  
**See it:** The choices in order, each with what it rejected.  

### `dsa-heap-top-k`: Heap / Top K
**What:** Keeps the k largest or smallest seen so far in a bounded heap.  
**Parts:** `heap`, `push`, `evict`  
**Invariants:** The heap never exceeds k.  
**Bugs:** A min-heap where a max-heap is meant.  
**See it:** The heap beside the stream.  

### `dsa-union-find`: Union-Find
**What:** Tracks which items belong together, with near-constant merges and lookups.  
**Parts:** `parent`, `find`, `union`  
**Invariants:** Each item has one root.  
**Bugs:** Skipping path compression or rank on large input.  
**See it:** Merging trees.  

### `dsa-monotonic-stack`: Monotonic Stack
**What:** A stack kept in sorted order, popping what a new item beats. Finds next-greater elements.  
**Parts:** `stack`, `pop-rule`, `answer`  
**Invariants:** The stack stays sorted. Each item is pushed and popped once.  
**Bugs:** Leftover items never processed at the end; strict versus non-strict comparison.  
**See it:** The stack growing and popping as a cursor moves.  

### `dsa-merge-intervals`: Merge Intervals
**What:** Sorts ranges by start and merges those that overlap.  
**Parts:** `sort`, `overlap-test`, `merge`  
**Invariants:** The output is sorted and has no overlaps.  
**Bugs:** Whether touching ends count as overlap; the merged end not taking the maximum.  
**See it:** Bars on a line collapsing together.  

### `dsa-bloom-filter`: Bloom Filter
**What:** A small structure that says "definitely not" or "maybe".  
**Parts:** `bit-array`, `hashes`, `add`, `check`  
**Invariants:** No false negatives. Items can't be removed.  
**Bugs:** Treating "maybe" as yes; a size that doesn't fit the load.  
**See it:** Bits lighting up per item.  

### `dsa-consistent-hashing`: Consistent Hashing
**What:** Places keys and nodes on a ring, so adding a node moves few keys.  
**Parts:** `ring`, `virtual-node`, `lookup`  
**Invariants:** Adding or removing a node moves only its neighbours' keys.  
**Bugs:** Too few virtual nodes, so load is uneven.  
**See it:** The ring with key ranges colored by node.  

### `dsa-lru-cache`: LRU Cache
**What:** Evicts the least recently used item, using a hash map and a linked list.  
**Parts:** `map`, `recency-list`, `evict`  
**Invariants:** The map and the list always agree. Size stays bounded.  
**Bugs:** Reads that don't update recency; races between the two structures.  
**See it:** The list reordering on each access.  
