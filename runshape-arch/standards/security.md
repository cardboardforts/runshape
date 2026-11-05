# Security standards

Controls should come from a threat model. These are the ones a threat model usually produces, so
leaving one out should be a decision.

### `std-authorize-at-the-resource`
**Rule:** Access is checked against the specific object, wherever it's read or changed.  
**Why:** Checking only that a user is logged in lets anyone read any record by changing an ID.  
**Check:** judgement  
**Severity:** error  

### `std-parameterized-queries`
**Rule:** SQL values are bound, never interpolated into the string.  
**Why:** Interpolated values are injection.  
**Check:** search  
**Severity:** error  

### `std-no-secrets-in-source`
**Rule:** No secret lives in code, committed config or images.  
**Why:** A credential that ever touched a commit has to be rotated, not deleted.  
**Check:** search  
**Severity:** error  

### `std-no-secrets-in-logs`
**Rule:** Credentials, tokens and personal data are redacted before a log line.  
**Why:** Many people can query a log aggregator.  
**Check:** judgement  
**Severity:** error  

### `std-pinned-dependencies`
**Rule:** A lockfile is committed, so builds are reproducible.  
**Why:** Most production code is code you didn't write.  
**Check:** search  
**Severity:** warn  
