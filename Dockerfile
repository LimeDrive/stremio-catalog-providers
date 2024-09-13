FROM node:18-slim AS builder

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --only=production --silent

FROM node:18-slim

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

ENV PORT=7000
EXPOSE 7000

RUN useradd -r -u 1001 -g node appuser
RUN chown -R appuser:node /usr/src/app

USER appuser

CMD ["node", "index.js"]
