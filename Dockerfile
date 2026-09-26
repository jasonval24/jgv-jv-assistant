FROM node:22-alpine

WORKDIR /app

COPY app/package.json app/package-lock.json ./app/
WORKDIR /app/app
RUN npm ci --omit=dev

WORKDIR /app
COPY . .

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

WORKDIR /app/app
CMD ["node", "src/server.js"]
