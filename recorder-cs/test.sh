#!/bin/sh
# The C# recorder's tests, as `npm test` runs them: skipped, and said so, only when there's no
# .NET SDK on this machine; a failing test fails the run.
set -e
if ! command -v dotnet >/dev/null 2>&1; then
  echo "recorder-cs: skipped (no dotnet on PATH; install the .NET 10 SDK to run its tests)"
  exit 0
fi
cd "$(dirname "$0")"
DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 MSBUILDDISABLENODEREUSE=1 \
  dotnet test Runshape.Recorder.slnx --nologo -nodeReuse:false -p:UseSharedCompilation=false --verbosity quiet
