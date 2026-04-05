FROM node:22-alpine AS build

WORKDIR /app

COPY runner/package*.json ./runner/
RUN cd runner && npm ci

COPY runner ./runner
COPY web ./web
COPY public ./public

RUN mkdir -p /app/build/public \
 && npx --prefix /app/runner html-minifier-terser \
    --collapse-whitespace \
    --remove-comments \
    --minify-css true \
    --minify-js true \
    -o /app/build/public/index.html \
    /app/web/index.html \
 && npx --prefix /app/runner html-minifier-terser \
    --collapse-whitespace \
    --remove-comments \
    --minify-css true \
    --minify-js true \
    -o /app/build/public/load-tester.html \
    /app/public/load-tester.html \
 && if [ -f /app/public/documentation.html ]; then \
      npx --prefix /app/runner html-minifier-terser \
        --collapse-whitespace \
        --remove-comments \
        --minify-css true \
        --minify-js true \
        -o /app/build/public/documentation.html \
        /app/public/documentation.html ; \
    fi

FROM node:22-alpine

RUN apk add --no-cache curl bash \
  && curl -L https://github.com/grafana/k6/releases/download/v0.49.0/k6-v0.49.0-linux-amd64.tar.gz \
  | tar -xz \
  && mv k6-v0.49.0-linux-amd64/k6 /usr/bin/k6 \
  && rm -rf k6-v0.49.0-linux-amd64

WORKDIR /app/runner

COPY runner/package*.json ./
RUN npm ci --omit=dev

COPY runner ./
COPY --from=build /app/build/public /app/public

EXPOSE 3000 5665

CMD ["npm", "start"]