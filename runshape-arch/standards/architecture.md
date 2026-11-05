# Architecture standards

### `std-composition-root`
**Rule:** Only one module per app wires the layers together.  
**Why:** The dependencies stay checkable: reading imports verifies the architecture.  
**Check:** imports. Find modules importing from more than one layer.  
**Severity:** warn  

### `std-no-import-cycles-between-systems`
**Rule:** Two systems don't import each other.  
**Why:** A cycle means neither can change, test or ship alone. This holds in every style.  
**Check:** imports  
**Severity:** warn  

### `std-constructor-injection`
**Rule:** Dependencies arrive through constructors, with no service locators or global state.  
**Why:** Dependencies stay visible, and substituting them in a test is trivial.  
**Check:** judgement  
**Severity:** info  
**With:** `modern-dependency-injection`  

### `std-domain-free-of-wire-formats`
**Rule:** A domain model isn't bent to fit a wire format; a DTO takes the difference.  
**Why:** Pagination, envelopes and API versions change for reasons the domain doesn't care about.  
**Check:** judgement  
**Severity:** info  
**With:** `dto`, `mapper`  

### `std-product-ignores-the-workshop`
**Rule:** Product code doesn't depend on the workshop. The workshop may reach into anything.  
**Why:** A pipeline or a task runner is a composition root: it wires the product, not the reverse.  
**Check:** imports  
**Severity:** warn  
**With:** `composition-root`, `docs`, `dev-tooling`, `delivery`  
