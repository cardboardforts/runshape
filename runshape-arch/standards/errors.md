# Error standards

### `std-collect-all-errors`
**Rule:** Validation reports every problem at once, not only the first.  
**Why:** Failing on the first hides information and makes the caller fix and retry repeatedly.  
**Check:** judgement  
**Severity:** info  

### `std-fail-loud-at-startup`
**Rule:** Required configuration or data that fails to load stops the service from starting.  
**Why:** A service that starts without its data is worse than no service.  
**Check:** judgement  
**Severity:** warn  

### `std-fail-closed`
**Rule:** An error in an authorization or token check means deny.  
**Why:** An exception that falls through to the happy path is a vulnerability.  
**Check:** judgement  
**Severity:** error  
