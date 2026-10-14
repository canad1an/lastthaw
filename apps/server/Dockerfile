# Builds both the api and worker entrypoints; the compose file picks which one to run.
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
COPY apps/server apps/server
RUN npm run build --workspace=@lastthaw/server

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/mapgen/package.json tools/mapgen/
RUN npm ci --omit=dev --workspace=@lastthaw/server
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/drizzle apps/server/drizzle
WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "dist/api/index.js"]
