FROM node:18-slim

# Install k6 from the official Grafana repo
RUN apt-get update && apt-get install -y gnupg curl ca-certificates && \
    curl -fsSL https://dl.k6.io/key.gpg | gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
      > /etc/apt/sources.list.d/k6.list && \
    apt-get update && apt-get install -y k6 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies first (layer-cache friendly)
COPY package.json .
RUN npm install --omit=dev

# Copy source
COPY . .

# Run artifacts are stored here — mount a volume if persistence is needed
RUN mkdir -p runs

EXPOSE 3000

CMD ["node", "server.js"]