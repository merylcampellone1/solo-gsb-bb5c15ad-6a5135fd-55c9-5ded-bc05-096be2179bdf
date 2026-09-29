# ---- 构建阶段：安装全部依赖并构建前端 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 使用预编译二进制；若回退源码编译则需要这些工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先拷贝 workspace 清单以利用 Docker 层缓存
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm install

# 拷贝源码并构建前端静态资源
COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/contract.db

# better-sqlite3 运行期仅依赖 node 自身，无需编译工具
COPY --from=build /app /app
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /data

VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
