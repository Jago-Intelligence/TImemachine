FROM node:24-bookworm-slim
# Bootstrap HTTPS verification from Node's bundled CA roots: slim images may
# not have the system ca-certificates package installed yet.
RUN node -p "require('node:tls').rootCertificates.join('\n')" > /tmp/apt-ca.pem \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/tmp/apt-ca.pem -o Acquire::Retries=3 update \
    && apt-get -o Acquire::https::CaInfo=/tmp/apt-ca.pem -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates postgresql-15 \
    && rm -rf /var/lib/apt/lists/* /tmp/apt-ca.pem
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY tooling ./tooling
COPY packages ./packages
COPY examples/express-delivery ./examples/express-delivery
RUN pnpm install --frozen-lockfile --filter @timemachine/example-express-delivery...     && pnpm exec turbo run build --filter=@timemachine/example-express-delivery...
USER node
ENTRYPOINT ["node", "examples/express-delivery/src/replay-runner.js"]
