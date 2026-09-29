#!/bin/bash
# Start the Neurolink brain server, then open the cockpit.
# Usage: ./start.sh        (rebuild index first: node rag-index.mjs)
cd "$(dirname "$0")" || exit 1
echo "🧠 starting Neurolink brain server on http://localhost:8920 …"
echo "   (set ANTHROPIC_API_KEY first to enable Claude reasoning)"
open "http://localhost:8920" 2>/dev/null &
node rag-server.mjs
