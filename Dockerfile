# Build the frontend, then run the tiny gateway (serves app + API).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Baked into the frontend at build time so the app can pass the gateway's
# shared-secret header. Set the same value as GATEWAY_TOKEN in Railway.
ARG VITE_GATEWAY_TOKEN=""
ENV VITE_GATEWAY_TOKEN=$VITE_GATEWAY_TOKEN
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV SERVE_DIR=./dist
COPY server/ ./server/
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "server/hf-gateway.js"]
