# Metadata

Decorators, attributes and annotations. A decorator is evidence, not a thing to display: classify it
by what it says about what it sits on, then feed that into roles and traits.

### `persistence-mapping`
`@Entity`, `@Table`, Django `models.Model`. Suggests `entity` or `dto`, depending on style.

### `transaction-boundary`
`@Transactional`, `atomic()`. Suggests `writes-state`, and marks a use-case edge.

### `authorization`
`@PreAuthorize`, `[Authorize]`, `@login_required`. Backs a rule: every `primary-adapter` needs one.

### `wiring`
`@Injectable`, `@Autowired`, `@Bean`. Marks a `composition-root`.

### `serialization`
`@JsonProperty`, pydantic `Field`. Suggests `dto`.

### `validation`
`@Valid`, `@NotNull`. Validation at the boundary.

### `observability`
`@Timed`, log decorators. Filter these out of the view.

### `lifecycle`
`@Deprecated`, `[Obsolete]`. A review callout when touched.

### `declares-role`
jMolecules, Spring stereotypes. The code says its own role: the strongest evidence.
