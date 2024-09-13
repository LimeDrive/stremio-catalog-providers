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

CMD ["node", "index.js"]
