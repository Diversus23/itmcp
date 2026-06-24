FROM node:22-slim AS builder

WORKDIR /app

# Копируем файлы зависимостей и устанавливаем
COPY package.json package-lock.json ./
RUN npm ci

# Копируем исходный код и собираем
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Production stage ---
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist/

# Запуск от непривилегированного пользователя
USER node

# Порт HTTP-сервера
EXPOSE 8000

# MCP_HOST=0.0.0.0 чтобы слушать на всех интерфейсах внутри контейнера
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8000/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js", "http"]
