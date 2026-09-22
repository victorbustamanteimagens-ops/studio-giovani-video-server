FROM node:20-slim

# ffmpeg do sistema (bem mais rapido que ffmpeg.wasm no navegador)
RUN apt-get update \
&& apt-get install -y --no-install-recommends ffmpeg \
&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
