# Frontend standards

### `std-server-is-the-trust-boundary`
**Rule:** Every invariant the UI enforces is also enforced on the server.  
**Why:** Anyone can call the API directly. Client validation is fast feedback, nothing more.  
**Check:** judgement  
**Severity:** error  

### `std-four-async-states`
**Rule:** An async view renders loading, error, empty and success.  
**Why:** Building only the success path ships a spinner that never ends or a blank screen.  
**Check:** judgement  
**Severity:** warn  

### `std-derive-dont-duplicate-state`
**Rule:** A value that can be computed from existing state is computed, not stored again.  
**Why:** Two pieces of state that should agree will drift apart.  
**Check:** judgement  
**Severity:** info  

### `std-real-elements`
**Rule:** Interactive elements are real elements (`button`, `label`, `nav`), operable by keyboard.  
**Why:** A `div` with a click handler is a broken button.  
**Check:** search  
**Severity:** warn  

### `std-stable-list-keys`
**Rule:** List keys come from domain identity, never the array index.  
**Why:** Index keys reuse the wrong DOM node when a list changes, and it looks like data corruption.  
**Check:** search  
**Severity:** warn  
