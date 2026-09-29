#!/bin/sh
# 容器首次运行保障：
#   1) 缺少 node_modules 时自动安装依赖（镜像已内置，此为 volume 覆盖等场景的兜底）；
#   2) 缺少前端构建产物时自动构建；
#   3) 数据目录不存在时自动创建（SQLite 建库由服务启动时的迁移自动完成）。
set -e

cd /app

if [ ! -d node_modules ]; then
  echo "[entrypoint] node_modules 缺失，执行 npm install …"
  npm install
fi

if [ ! -d client/dist ]; then
  echo "[entrypoint] 前端构建产物缺失，执行 npm run build …"
  npm run build
fi

mkdir -p "$(dirname "$DB_PATH")"

echo "[entrypoint] 启动服务于 http://localhost:${PORT:-3000}"
exec npm run start
