# The Go recorder, sealed: this checkout's recorder-go, built from trusted code only. A pull
# request's code never enters the image; it's mounted at /target when a commit is recorded
# (packages/adapters/src/recorders/go/go-sandbox.ts says how, docker-recorder.ts runs it).
# Pinned to the Go the host records with, so a sandboxed recording and a local one compare.
FROM golang:1.27.2-bookworm

# node, for the registry proxy: the install's only way out (recorder-ts/sandbox/registry-proxy.mjs).
COPY --from=node:23.11.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /runshape
COPY recorder-go recorder-go
COPY recorder-ts/sandbox/registry-proxy.mjs recorder-ts/sandbox/registry-proxy.mjs
# runshape-go points each recorded copy at its own source (/runshape/recorder-go), which stays.
RUN cd recorder-go && go build -o /runshape/bin/runshape-go ./cmd/runshape-go && node --version && chmod -R a+rX /runshape
