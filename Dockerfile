FROM node:18

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .

RUN npm run build || true

# Install pm2 globally
RUN npm install -g pm2

EXPOSE 8989
ENV NODE_ENV=production

# Start pm2 with both worker and ddex processes
CMD pm2-runtime start ecosystem.config.js --only worker,ddex
