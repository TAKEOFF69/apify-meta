FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

RUN npm prune --production

CMD ["node", "build/main.js"]
