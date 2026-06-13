#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

# ── 模式 ──
# ./start.sh          开发模式（cargo run + npm run dev，热重载）
# ./start.sh --build  构建产物（cargo build --release + npm run build）
# ./start.sh --prod   构建并以生产模式运行（build + cargo run --release + vite preview）

MODE="${1:-dev}"

cleanup() {
    echo "Shutting down..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
    echo "Done."
}
trap cleanup EXIT INT TERM

if [ "$MODE" = "--build" ]; then
    echo "=== Building backend (release) ==="
    cd "$BACKEND" && cargo build --release

    echo "=== Building frontend ==="
    cd "$FRONTEND" && npm run build

    echo "=== Build complete ==="
    echo "  Backend binary: $BACKEND/target/release/conclave"
    echo "  Frontend dist:  $FRONTEND/dist/"
    exit 0
fi

if [ "$MODE" = "--prod" ]; then
    echo "=== Building backend (release) ==="
    cd "$BACKEND" && cargo build --release

    echo "=== Building frontend ==="
    cd "$FRONTEND" && npm run build

    echo "=== Starting in production mode ==="
    cd "$BACKEND" && ./target/release/conclave &
    BACKEND_PID=$!

    cd "$FRONTEND" && npm run preview &
    FRONTEND_PID=$!

    echo "Backend:  http://localhost:${PORT:-3001}"
    echo "Frontend: http://localhost:4173"
    wait
    exit 0
fi

# ── 开发模式（默认） ──
# 先编译后直接运行二进制（避免 cargo run 派生子进程导致 Ctrl+C 杀不干净）
echo "Building backend..."
cd "$BACKEND" && cargo build 2>&1 | tail -3

echo "Starting backend..."
cd "$BACKEND" && ./target/debug/conclave-backend &
BACKEND_PID=$!

echo "Starting frontend (dev)..."
cd "$FRONTEND" && npm run dev &
FRONTEND_PID=$!

echo "Backend:  http://localhost:${PORT:-3001}"
echo "Frontend: http://localhost:5173"
wait
