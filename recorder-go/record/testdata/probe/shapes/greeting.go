package shapes

import "fmt"

// Greeting is built while the package initialises, through Color's String method in another
// file: instrumentation must not change the order in which that works.
var Greeting = fmt.Sprint(Color(1))
