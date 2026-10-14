# The Arc founder demo on one Fly.io machine: Fuel's API, the shop, the Try-it
# door and its approver. See deploy/fly/README.md for what runs as whom.
#
# Built from the repository root:  fly deploy --ha=false (fly.toml is at the root)
# The build context is filtered by the root .dockerignore (an allowlist).
FROM node:24-slim

ARG FUEL_COMMIT=unknown
ENV FUEL_COMMIT=$FUEL_COMMIT
ENV NODE_ENV=production

# Four system users, so a bug in a public process cannot read a key it was
# never given: `api` holds the agent's chain key, `shop` the shop's, `tryit`
# (the public door) only Fuel's agent key, and `approver` only the operator key.
RUN groupadd -r fuel && \
    useradd -r -g fuel -d /home/api -m api && \
    useradd -r -g fuel -d /home/shop -m shop && \
    useradd -r -g fuel -d /home/tryit -m tryit && \
    useradd -r -g fuel -d /home/approver -m approver && \
    mkdir -p /data

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# tsx is a devDependency, and the processes run under it, so install everything.
RUN npm ci --ignore-scripts && npm cache clean --force
COPY src ./src
COPY demo ./demo
COPY scripts/arc-demo ./scripts/arc-demo
COPY deploy/fly/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && chown -R root:fuel /app && chmod -R o-rwx /app

EXPOSE 3220
ENTRYPOINT ["/entrypoint.sh"]
