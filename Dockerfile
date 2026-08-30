FROM node:26-slim AS builder

WORKDIR /app

# Копируем файлы зависимостей и устанавливаем.
# --ignore-scripts: пропускаем lifecycle-скрипты (в т.ч. prepare/husky) —
# в образе нет .git и dev-инструментов хуков, сборка их не требует.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Копируем исходный код и собираем
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Production stage ---
FROM node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist/

# Каталог для персистентных данных (OAuth2-снапшот). Создаём заранее с
# владельцем node: именованный Docker-том унаследует эти права, и снапшот
# будет записываться без ручного chown. Для bind-mount каталога с хоста
# права всё равно определяет хост — см. docker-compose.yml.
RUN mkdir -p /app/data && chown node:node /app/data

# Запуск от непривилегированного пользователя
USER node

# Порт HTTP-сервера
EXPOSE 8000

# MCP_HOST=0.0.0.0 чтобы слушать на всех интерфейсах внутри контейнера
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8000
# Персистентность OAuth2-токенов включена по умолчанию: без неё каждый
# перезапуск контейнера сбрасывает всех клиентов на повторную авторизацию.
# Значение можно переопределить в .env (env_file в docker-compose).
ENV MCP_OAUTH2_STORE_PATH=/app/data/oauth2.json

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8000/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js", "http"]
