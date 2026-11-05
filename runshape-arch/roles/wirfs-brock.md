# Wirfs-Brock stereotypes

The fallback when no style has been chosen, so code can still get a role. Everything else in this
folder is a refinement of one of these, so a rule can say "any `coordinator` holding state is
suspect" without knowing the style. Not in `taxonomy.ts` yet.

### `information-holder`
Knows things, and provides information.

### `structurer`
Maintains relationships between objects.

### `service-provider`
Performs work on request.

### `coordinator`
Reacts to events by delegating to others.

### `controller-stereotype`
Makes decisions and directs others' actions. Called "controller" in the original; renamed here to
keep it apart from the MVC role.

### `interfacer`
Transforms information between parts of a system or across its edge.
