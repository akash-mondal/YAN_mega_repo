FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

# Install dependencies and TypeScript globally
RUN npm install && npm install -g typescript

COPY . .

# Build the project
RUN tsc

EXPOSE 10000

CMD ["node", "dist/index.js"]
