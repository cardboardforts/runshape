# The C# recorder, sealed: this checkout's recorder-cs, built from trusted code only. A pull
# request's code never enters the image; it's mounted at /target when a commit is recorded
# (packages/adapters/src/recorders/csharp/csharp-sandbox.ts says how, docker-recorder.ts runs it).
# Pinned to the SDK the host records with (recorder-cs/global.json), so recordings compare.
FROM mcr.microsoft.com/dotnet/sdk:10.0.301

# node, for the registry proxy: the install's only way out (recorder-ts/sandbox/registry-proxy.mjs).
COPY --from=node:23.11.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
WORKDIR /runshape
COPY recorder-cs recorder-cs
COPY recorder-ts/sandbox/registry-proxy.mjs recorder-ts/sandbox/registry-proxy.mjs
# The recorder's own packages: from nuget.org, as its lock files pin them, and nothing else.
RUN cd recorder-cs \
 && dotnet restore src/Runshape.Record/Runshape.Record.csproj --locked-mode --configfile nuget.config \
 && dotnet publish src/Runshape.Record/Runshape.Record.csproj --no-restore -c Release -o /runshape/bin \
 && rm -rf src/*/bin src/*/obj /root/.nuget \
 && node --version && chmod -R a+rX /runshape && chmod a+x /runshape/recorder-cs/sandbox/download-packages.sh
