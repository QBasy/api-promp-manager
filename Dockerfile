FROM node:20

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY static ./static

RUN npm install -g ts-node typescript

EXPOSE 3000

CMD ["ts-node", "src/index.ts"]
