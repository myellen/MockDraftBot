FROM node:lts-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build
CMD GUILD_ID= node build/deploy-commands.js && node build/index.js
