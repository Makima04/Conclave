#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

cleanup() {
    echo "Shutting down..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
    echo "Done."
}
trap cleanup EXIT INT TERM

echo "Starting backend..."
cd "$BACKEND" && cargo run &
BACKEND_PID=$!

echo "Starting frontend..."
cd "$FRONTEND" && npm run dev &
FRONTEND_PID=$!

wait
