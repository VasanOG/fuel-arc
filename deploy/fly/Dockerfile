# The Arc founder demo on one Fly.io machine: Fuel's API, the shop, the Try-it
# door and its approver. See deploy/fly/README.md for what runs as whom.
#
# Built from the repository root:  fly deploy --ha=false (fly.toml is at the root)
# The build context is filtered by the root .dockerignore (an allowlist).
FROM node:24-slim

ARG FUEL_COMMIT=unknown
ENV FUEL_COMMIT=$FUEL_COMMIT
ENV NODE_ENV=production

# Five system users, so a bug in a public process cannot read a key it was
# never given: `api` holds the agent's chain key, `shop` the shop's, `tryit`
# (the public door) only Fuel's agent key, `approver` only the operator key,
# and `web` (the dashboard and the front proxy) only the sign-in relay key.
RUN groupadd -r fuel && \
    useradd -r -g fuel -d /home/api -m api && \
    useradd -r -g fuel -d /home/shop -m shop && \
    useradd -r -g fuel -d /home/tryit -m tryit && \
    useradd -r -g fuel -d /home/approver -m approver && \
    useradd -r -g fuel -d /home/web -m web && \
    mkdir -p /data

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# tsx is a devDependency, and the processes run under it, so install
# everything. --include=dev is required: NODE_ENV=production (set above)
# otherwise makes npm skip devDependencies, and every process then fails
# with "Cannot find package 'tsx'".
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force && test -d node_modules/tsx
COPY src ./src
COPY demo ./demo
COPY scripts/arc-demo ./scripts/arc-demo
# The dashboard: its own dependencies, built for production here. Next writes
# its runtime cache under .next, which is the one part of /app `web` may write.
COPY dashboard ./dashboard
RUN cd dashboard && npm ci --include=dev --ignore-scripts && NEXT_TELEMETRY_DISABLED=1 npm run build && npm cache clean --force && test -f .next/BUILD_ID
COPY deploy/fly/entrypoint.sh /entrypoint.sh
COPY deploy/fly/front.mjs /app/deploy/fly/front.mjs
RUN chmod 755 /entrypoint.sh && chown -R root:fuel /app && chmod -R o-rwx /app && chown -R web:fuel /app/dashboard/.next

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3220
ENTRYPOINT ["/entrypoint.sh"]
