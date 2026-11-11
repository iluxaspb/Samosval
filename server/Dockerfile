FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN NODE_OPTIONS=--tls-max-v1.2 npm install --omit=dev --ignore-scripts --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1 && npm cache clean --force
COPY src ./src
COPY scripts/import-firebase-users.mjs ./scripts/import-firebase-users.mjs
RUN chmod -R a+rX /app/src /app/scripts
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/index.mjs"]
