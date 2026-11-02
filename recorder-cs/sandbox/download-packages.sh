#!/bin/sh
# The C# sandbox's install step: fetches exactly the packages the commit's packages.lock.json
# files name (the host read them, and passes each as an "id@version" argument, checked against
# a strict pattern), from nuget.org only, into /target/.runshape-nuget.
#
# The fetch is a project of the recorder's own, made here in /tmp, so none of the commit's
# MSBuild (its .csproj, Directory.Build.props, a target hooked to restore) runs while there is
# a network. Its own restore runs later, in the record step, with no network at all, from what
# this fetched, in locked mode: each package's hash is checked against its lock file there.
set -eu
project=/tmp/runshape-download
mkdir -p "$project"
{
  echo '<Project Sdk="Microsoft.NET.Sdk">'
  echo '  <PropertyGroup><TargetFramework>net10.0</TargetFramework><ImportDirectoryBuildProps>false</ImportDirectoryBuildProps><ImportDirectoryBuildTargets>false</ImportDirectoryBuildTargets></PropertyGroup>'
  echo '  <ItemGroup>'
  for package in "$@"; do
    id=${package%@*}
    version=${package##*@}
    echo "    <PackageDownload Include=\"$id\" Version=\"[$version]\" />"
  done
  echo '  </ItemGroup>'
  echo '</Project>'
} > "$project/download.csproj"
cd "$project"
dotnet restore download.csproj --configfile /runshape/recorder-cs/nuget.config --packages /target/.runshape-nuget -nodeReuse:false
