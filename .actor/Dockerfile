FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./
RUN npm install --include=dev --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

RUN npm prune --production

CMD ["node", "build/main.js"]
