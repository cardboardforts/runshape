# The Python recorder, sealed: this checkout's recorder/src, built from trusted code only. A pull
# request's code never enters the image; it's mounted at /target when a commit is recorded
# (packages/adapters/src/recorders/python/python-sandbox.ts says how, docker-recorder.ts runs it).
# Pinned to one Python: projects that need another are recorded on the host (a limit, PLAN.md Phase 7).
FROM python:3.12.9-slim-bookworm

# node, for the registry proxy: the install's only way out (recorder-ts/sandbox/registry-proxy.mjs).
COPY --from=node:23.11.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node

# pytest, for requirements that don't pin one: the commit's venv sees the image's packages.
RUN pip install --no-cache-dir pytest==8.4.2

WORKDIR /runshape
COPY recorder/src recorder/src
COPY recorder-ts/sandbox/registry-proxy.mjs recorder-ts/sandbox/registry-proxy.mjs
RUN node --version && chmod -R a+rX /runshape
