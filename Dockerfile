FROM node:22-bookworm

# ffmpeg：把每個人的音軌混成一個音檔
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
ENV TZ=Asia/Taipei
CMD ["node", "index.js"]
