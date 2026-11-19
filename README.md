# Ludo Online

Play Ludo with friends using a 4-letter room code. No dependencies, just Node 18+.

## Run locally
    node server.js
Open http://localhost:3000

## Put it online (Render, free)
1. Put these 3 files (server.js, index.html, package.json) in a GitHub repository.
2. On render.com: New > Web Service > connect the repository.
3. Build command: leave empty (or `echo ok`). Start command: `node server.js`. Instance type: Free.
4. When it is live, open the URL, create a room and send friends the invite link.

Note: on Render's free plan the server sleeps after ~15 minutes without visitors. The first visit afterwards takes about a minute to wake it, and games in progress are lost if it restarts.
