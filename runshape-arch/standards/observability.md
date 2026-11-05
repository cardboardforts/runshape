# Observability standards

### `std-log-unhandled-exceptions`
**Rule:** Every entry point logs an unhandled exception with its stack and context before returning.  
**Why:** The 500 tells the caller something went wrong. Only the log says what.  
**Check:** search for the catch-all at each entry point, then judgement  
**Severity:** error  

### `std-correlation-id`
**Rule:** Every request carries a correlation ID through every log line.  
**Why:** Without one, finding a failed request's logs means searching a haystack.  
**Check:** search  
**Severity:** warn  

### `std-readiness-checks-dependencies`
**Rule:** A readiness endpoint verifies the service can do its job: data loaded, dependencies reachable.  
**Why:** A health check that always returns 200 is a lie.  
**Check:** judgement  
**Severity:** warn  

### `std-structured-logs`
**Rule:** Logs are machine-readable, with timestamp, level, service and correlation ID.  
**Why:** The value of logs comes from querying and correlating them.  
**Check:** search  
**Severity:** info  
