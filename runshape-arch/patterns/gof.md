# Gang of Four, modernized

Many of these shrink in modern languages: a first-class function is often a whole Strategy, and a
module is often a Singleton. Tag the idea, not the class diagram.

## Creational

### `gof-factory-method`: Factory Method
**What:** A method decides which concrete type to build, so callers depend only on the abstraction.  
**Parts:** `product`, `creator`, `concrete-creator`  
**Invariants:** Callers never name a concrete product. Every product honours the abstraction.  
**Bugs:** A growing `switch` on type that every new product must edit.  
**Look-alikes:** `gof-abstract-factory` builds families; this builds one thing.  
**See it:** The creator with arrows to the products it can return, the chosen one lit per call.  

### `gof-abstract-factory`: Abstract Factory
**What:** One object builds a family of related things that must match each other.  
**Parts:** `factory`, `concrete-factory`, `product-family`  
**Invariants:** Products from one factory are always used together, never mixed across families.  
**Bugs:** A new product type forces edits to every factory.  
**See it:** Columns of families and rows of product types, one column lit.  

### `gof-builder`: Builder
**What:** Assembles a complex object step by step, separating the steps from the final value.  
**Parts:** `builder`, `step`, `result`  
**Invariants:** `build` returns a valid object or fails. Partly built objects don't escape.  
**Bugs:** Required fields only enforced by convention; a builder reused and sharing state.  
**Look-alikes:** A plain constructor with named arguments, which is often all you need.  
**See it:** The steps in order, with the object filling in.  

### `gof-prototype`: Prototype
**What:** New objects are made by copying an existing one.  
**Parts:** `prototype`, `clone`  
**Invariants:** A clone shares no mutable state with its original unless that's intended.  
**Bugs:** A shallow copy that shares nested state.  
**See it:** The original and clone side by side, with shared references marked.  

### `gof-singleton`: Singleton
**What:** Exactly one instance, reachable from a known place.  
**Parts:** `instance`, `accessor`  
**Invariants:** One instance per process, created safely under concurrency.  
**Bugs:** Hidden global state that makes tests depend on order.  
**See it:** One node with every caller pointing at it.  
**Conflicts:** `std-constructor-injection`  

## Structural

### `gof-adapter`: Adapter
**What:** Makes one interface look like another that the caller expects.  
**Parts:** `target`, `adapter`, `adaptee`  
**Invariants:** It translates and adds no business logic. The adaptee's types don't leak out.  
**Bugs:** Errors passed through in the vendor's terms; logic accumulating in the adapter.  
**Look-alikes:** `gof-facade` simplifies; this converts. `gof-proxy` keeps the same interface.  
**See it:** The caller, the adapter and the adaptee, with types changing as they cross.  
**With:** `secondary-adapter`  

### `gof-bridge`: Bridge
**What:** Separates an abstraction from its implementation so each can vary alone.  
**Parts:** `abstraction`, `implementor`  
**Invariants:** The abstraction reaches the implementation only through its interface.  
**Bugs:** Both sides change together anyway, so the split costs without paying.  
**See it:** Two hierarchies joined by one link.  

### `gof-composite`: Composite
**What:** Treats a single thing and a tree of things through one interface.  
**Parts:** `component`, `leaf`, `composite`  
**Invariants:** Any operation works on a leaf or a subtree. No cycles.  
**Bugs:** Operations that assume leaves; unbounded recursion on deep trees.  
**See it:** The tree, with a call spreading down it.  

### `gof-decorator`: Decorator
**What:** Wraps an object to add behaviour, keeping its interface.  
**Parts:** `component`, `decorator`  
**Invariants:** Wrappers stack in any order that's meant to work, and each calls through.  
**Bugs:** Order dependence nobody wrote down, such as caching outside or inside auth.  
**Look-alikes:** `gof-proxy` controls access; this adds behaviour.  
**See it:** Nested layers, with a call going in and back out.  

### `gof-facade`: Facade
**What:** One simple entry point in front of a complicated subsystem.  
**Parts:** `facade`, `subsystem`  
**Invariants:** Callers don't need to reach past it.  
**Bugs:** Growing into a god object.  
**See it:** One box in front of many, with callers stopping at it.  

### `gof-flyweight`: Flyweight
**What:** Shares immutable state across many objects to save memory.  
**Parts:** `flyweight`, `factory`, `extrinsic-state`  
**Invariants:** Shared state is immutable.  
**Bugs:** Something mutating shared state; a cache that never evicts.  
**See it:** Many instances pointing at a few shared ones.  

### `gof-proxy`: Proxy
**What:** A stand-in with the same interface that controls access to the real thing.  
**Parts:** `subject`, `proxy`  
**Invariants:** Callers can't tell it apart, apart from what it controls.  
**Bugs:** Lazy loading that hides a query in what looks like a field read.  
**See it:** The caller, the stand-in and the real object, with the decision marked.  

## Behavioral

### `gof-chain-of-responsibility`: Chain of Responsibility
**What:** A request passes along handlers until one deals with it. HTTP middleware is the modern form.  
**Parts:** `handler`, `chain`, `next`  
**Invariants:** Each handler either handles or passes on, and the order is deliberate.  
**Bugs:** Forgetting to call next; auth ordered after the work it protects.  
**See it:** The handlers in a row, with the request stopping at one.  

### `gof-command`: Command
**What:** Packages a request as an object so it can be queued, logged or undone.  
**Parts:** `command`, `invoker`, `receiver`  
**Invariants:** A command holds everything needed to run it later.  
**Bugs:** Commands holding references that change before they run.  
**See it:** A queue of commands reaching their receivers.  
**With:** `command`, `command-handler`  

### `gof-interpreter`: Interpreter
**What:** Represents a small language as a tree and evaluates it.  
**Parts:** `grammar`, `expression`, `context`  
**Invariants:** Every valid input maps to one tree.  
**Bugs:** Precedence mistakes; unbounded evaluation of hostile input.  
**See it:** The parsed tree, evaluated bottom up.  

### `gof-iterator`: Iterator
**What:** Walks a collection without exposing how it's stored. Built into most languages now.  
**Parts:** `iterator`, `aggregate`  
**Invariants:** One pass visits each element once.  
**Bugs:** Changing the collection mid-walk.  
**See it:** A cursor moving along the collection.  

### `gof-mediator`: Mediator
**What:** Objects talk through a central coordinator rather than to each other.  
**Parts:** `mediator`, `colleague`  
**Invariants:** Colleagues don't reference each other directly.  
**Bugs:** The mediator absorbing all the logic.  
**See it:** A hub with spokes.  

### `gof-memento`: Memento
**What:** Captures an object's state so it can be restored, without exposing it.  
**Parts:** `originator`, `memento`, `caretaker`  
**Invariants:** A snapshot restores exactly, and is opaque to the caretaker.  
**Bugs:** Shallow snapshots; unbounded history.  
**See it:** A timeline of snapshots.  

### `gof-observer`: Observer
**What:** Subscribers are told when something changes, and the source doesn't know who they are.  
**Parts:** `subject`, `observer`, `subscribe`, `notify`  
**Invariants:** Every live subscriber is told once per change. A dead subscriber is removed.  
**Bugs:** Forgotten unsubscribes leaking memory; a subscriber's failure breaking the others; ordering assumptions.  
**See it:** One source fanning out to its subscribers.  

### `gof-state`: State
**What:** Behaviour changes with an explicit state, each state being its own object or case.  
**Parts:** `context`, `state`, `transition`  
**Invariants:** Every transition is legal, and only allowed transitions exist.  
**Bugs:** A state nobody can leave; two flags that can disagree with the state.  
**Look-alikes:** `gof-strategy` is chosen by a caller; a state changes itself.  
**See it:** The state diagram, with the current state lit.  

### `gof-strategy`: Strategy
**What:** Interchangeable algorithms behind one interface, picked at runtime.  
**Parts:** `context`, `strategy`, `concrete-strategy`  
**Invariants:** Any strategy can replace another without the caller changing.  
**Bugs:** Strategies that subtly differ in what they require; a caller checking which one it has.  
**See it:** The context with its options, and the chosen one lit per request.  
**With:** `policy`  

### `gof-template-method`: Template Method
**What:** A fixed sequence with steps filled in by subclasses or callbacks.  
**Parts:** `template`, `hook`  
**Invariants:** The sequence belongs to the template, and overrides don't break it.  
**Bugs:** Overrides that forget to call the base; deep inheritance.  
**See it:** The sequence with its fillable slots marked.  

### `gof-visitor`: Visitor
**What:** Adds operations to a set of types without changing them.  
**Parts:** `visitor`, `element`, `accept`  
**Invariants:** Every element type is handled.  
**Bugs:** A new element type missed. Exhaustive pattern matching often replaces this.  
**See it:** A grid of element types and operations.  
