# Builds the static site and copies it into the shared "webdist" volume that Caddy serves.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/mapgen/package.json tools/mapgen/
RUN npm ci
COPY tsconfig.base.json .
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace=@lastthaw/web

FROM alpine:3.20
COPY --from=build /app/apps/web/dist /site
VOLUME /srv/web
CMD ["sh", "-c", "rm -rf /srv/web/* && cp -r /site/. /srv/web/ && echo 'web assets published' && sleep infinity"]
