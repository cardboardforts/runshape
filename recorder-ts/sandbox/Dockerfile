# The recorder, sealed: this checkout's recorder-ts and its dependencies, built from trusted
# code only. A pull request's code never enters the image; it's mounted at /target when a
# commit is recorded (packages/adapters/src/recorders/docker-recorder.ts runs it, and says how).
# Pinned to the Node the host records with, so a sandboxed recording and a local one compare.
FROM node:23.11.0-bookworm-slim

# git: tests that make repositories of their own (the recordings library's, the CLI's).
RUN apt-get update && apt-get install --yes --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# npm 11, as package.json's packageManager pins: npm 10 can't resolve vitest 5's peers.
RUN npm install --global npm@11.21.0 && npm cache clean --force

WORKDIR /runshape
COPY --chown=node:node . .
# Scripts stay off: nothing a dependency ships runs at install, here or in /target.
RUN npm ci --ignore-scripts --no-audit --no-fund && chown -R node:node /runshape

USER node
