#!/bin/sh
# npm run self-review [-- <base-ref> [<head-ref>]]   (default: main, and the working tree)
#
# Runshape reviewing its own change: records the core packages' tests at <base-ref> (once per
# commit) and at <head-ref> or the working tree, and prints the demo link comparing them.
# The same as `npm run runshape -- compare <base> [<head>]`; `npm run runshape -- list` shows
# every recording kept, and what else could be recorded.
set -eu
exec npm run --silent runshape -- compare "${1:-main}" ${2:+"$2"}
