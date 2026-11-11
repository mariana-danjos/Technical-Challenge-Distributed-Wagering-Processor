FROM oven/bun:1.4

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
