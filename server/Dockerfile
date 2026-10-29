FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/index.mjs"]
