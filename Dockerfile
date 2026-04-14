FROM node:lts-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm install
COPY . .
RUN npm run build && cd web && npm run build
CMD GUILD_ID= node build/deploy-commands.js && node build/index.js
