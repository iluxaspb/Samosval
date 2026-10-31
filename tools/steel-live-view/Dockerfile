FROM node:24-alpine
WORKDIR /opt/viewer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs panel.js handoff.mjs ./
USER node
CMD ["node", "server.mjs"]
