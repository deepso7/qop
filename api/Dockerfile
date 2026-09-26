# Build from the repo root: docker build -f api/Dockerfile .
# The build stage follows https://pnpm.io/docker. The API is bundled into one file,
# so the runtime image only needs a node binary.
FROM ghcr.io/pnpm/pnpm:12.5.1 AS build
RUN pnpm runtime set node 24 -g
COPY . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @qop/api...
RUN pnpm --filter @qop/api build

# Alpine plus node's musl binary is smaller than any glibc base with node.
FROM alpine:3.24
RUN apk add --no-cache libstdc++
COPY --from=node:24.20.0-alpine3.24 /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/api/dist ./
USER nobody
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "--enable-source-maps", "main.mjs"]
