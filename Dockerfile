FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm install -g ts-node typescript

RUN mkdir -p static

EXPOSE 3000

ENV OPENAI_KEY=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
ENV PORT=3000

CMD ["ts-node", "src/index.ts"]
