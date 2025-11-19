FROM node:20

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY static ./static

RUN npm install -g ts-node typescript

EXPOSE 3000

CMD ["ts-node", "src/index.ts"]
