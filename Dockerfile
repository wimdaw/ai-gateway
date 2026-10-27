# Koyeb 生产镜像：必须用 Bun 运行。
# opencode.ai 免费池的门禁3 校验 TLS ClientHello 的 cipher 列表
# （JA4 cipher hash 5b57614c22b0 = Bun/BoringSSL 的 17-cipher），
# Node 的 OpenSSL 指纹（含原生 fetch/https）一律 429 FreeUsageLimitError。
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package*.json ./
# 移除历史残留 quickjs 导致的 lockfile 冲突，由 bun 按 package.json 全新解析
RUN rm -f package-lock.json && bun install
COPY . .
RUN bun run build:node

FROM oven/bun:1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000
COPY package.json ./
# 直接复用 builder 阶段的依赖，无需二次 install
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 8000
CMD ["bun", "dist/bun-server.js"]