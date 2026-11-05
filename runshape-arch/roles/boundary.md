# Boundary

### `dto`
A wire or persistence shape: data that crosses a boundary, bent to the format, not the domain.
Signals: name says request, response, schema or DTO; no behaviour of its own.
Look-alikes: `entity` has identity and behaviour in the domain. `value-object` is a domain concept,
not a wire shape.

### `mapper`
Converts between a DTO and a domain type. Names: `*Mapper`, `*Serializer`, `*Converter`, `*Translator`.
Look-alike: `dto` is the shape itself.

### `config`
Typed settings read once at startup. Names: `*Settings`, `*Config`, `*Configuration`, `*Options`.
