FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
