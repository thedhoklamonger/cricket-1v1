FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY server.js EVENTS.md README.md ./
COPY public ./public
COPY data ./data

EXPOSE 3000
CMD ["node", "server.js"]
