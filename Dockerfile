FROM node:24-bookworm-slim AS node

FROM composer:2 AS composer

WORKDIR /app

COPY analyzers/php/composer.json analyzers/php/composer.lock analyzers/php/
COPY analyzers/php/src analyzers/php/src
RUN composer install --working-dir=analyzers/php --no-dev --no-interaction --no-progress --prefer-dist --classmap-authoritative

FROM php:8.4-cli-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local /usr/local
COPY --from=composer /usr/bin/composer /usr/local/bin/composer

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY --from=composer /app/analyzers/php/vendor analyzers/php/vendor

COPY . .

CMD ["node", "bin/review.js", "--help"]
