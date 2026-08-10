// Godot lobby + WebRTC signaling server with host migration.
//
// Protocol (JSON over WebSocket). Types mirror the official Godot
// webrtc_signaling demo, extended with lobby browsing + host migration.
//
// Client -> Server:
//   {type: "list"}                          request public lobby list
//   {type: "create", name, lobbyName, maxPlayers}
//   {type: "join", code, name}
//   {type: "leave"}
//   {type: "start"}                         host seals lobby / starts game
//   {type: "signal", to, data}              relay WebRTC message to peer
//
// Server -> Client:
//   {type: "id", id}                        assigned peer id
//   {type: "lobby_list", lobbies:[{code,name,players,maxPlayers,inGame}]}
//   {type: "joined", code, id, hostId, name, players:[{id,name}]}
//   {type: "peer_joined", id, name}
//   {type: "peer_left", id}
//   {type: "host_changed", hostId}          host migration happened
//   {type: "start"}                         game is starting
//   {type: "error", message}
//   {type: "signal", from, data}
//   {type: "pong"}
//
// Run standalone:   node server.js            (listens on PORT or 8080)
// Embedded in HTTP: require("./server.js").attach(httpServer)  (see serve.js)

const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// Map code -> lobby object.
// Lobby: { code, name, maxPlayers, inGame, hostId, members: Map<id, {ws, name}> }
const lobbies = new Map();

// Per-connection state.
// ws.app = { id, code, name }
function appOf(ws) { return ws.app || null; }

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendToLobby(lobby, msg, exceptId = 0) {
  for (const [id, m] of lobby.members) {
    if (id !== exceptId) send(m.ws, msg);
  }
}

function lobbySummary(lobby) {
  return {
    code: lobby.code,
    name: lobby.name,
    players: lobby.members.size,
    maxPlayers: lobby.maxPlayers,
    inGame: lobby.inGame,
  };
}

function publicLobbies() {
  const out = [];
  for (const l of lobbies.values()) {
    if (l.members.size >= l.maxPlayers) continue;
    out.push(lobbySummary(l));
  }
  return out;
}

function broadcastLobbyList(wss) {
  const msg = { type: "lobby_list", lobbies: publicLobbies() };
  for (const ws of wss.clients) send(ws, msg);
}

function randomCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < len; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
  } while (lobbies.has(code));
  return code;
}

function removeFromLobby(ws, wss) {
  const app = appOf(ws);
  if (!app) return;
  const lobby = lobbies.get(app.code);
  ws.app = null;
  if (!lobby) return;

  const leavingId = app.id;
  const wasHost = lobby.hostId === leavingId;
  lobby.members.delete(leavingId);

  if (lobby.members.size === 0) {
    lobbies.delete(app.code);
    broadcastLobbyList(wss);
    return;
  }

  // Notify others before deciding host so nobody sees a missing peer as host.
  sendToLobby(lobby, { type: "peer_left", id: leavingId }, leavingId);

  if (wasHost) {
    // Host migration: promote the next member (lowest id) to host.
    const nextId = Math.min(...lobby.members.keys());
    lobby.hostId = nextId;
    sendToLobby(lobby, { type: "host_changed", hostId: nextId });
    console.log(`[migrate] lobby ${app.code}: host ${leavingId} left -> ${nextId}`);
  }

  broadcastLobbyList(wss);
}

function handleMessage(ws, raw, wss) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  const app = appOf(ws);

  switch (msg.type) {
    case "list":
      send(ws, { type: "lobby_list", lobbies: publicLobbies() });
      break;

    case "create": {
      if (app) return send(ws, { type: "error", message: "already_in_lobby" });
      const name = String(msg.name || "Player").slice(0, 24);
      const lobbyName = String(msg.lobbyName || `${name}'s game`).slice(0, 40);
      const maxPlayers = Math.max(2, Math.min(8, parseInt(msg.maxPlayers, 10) || 4));
      const code = randomCode();
      const lobby = {
        code,
        name: lobbyName,
        maxPlayers,
        inGame: false,
        hostId: 1,
        members: new Map(),
      };
      ws.app = { id: 1, code, name };
      lobby.members.set(1, { ws, name });
      lobbies.set(code, lobby);

      send(ws, {
        type: "joined",
        code,
        id: 1,
        hostId: 1,
        name,
        players: [{ id: 1, name }],
      });
      broadcastLobbyList(wss);
      break;
    }

    case "join": {
      if (app) return send(ws, { type: "error", message: "already_in_lobby" });
      const code = String(msg.code || "").trim().toUpperCase();
      const lobby = lobbies.get(code);
      if (!lobby) return send(ws, { type: "error", message: "lobby_not_found" });
      if (lobby.members.size >= lobby.maxPlayers)
        return send(ws, { type: "error", message: "lobby_full" });

      const name = String(msg.name || "Player").slice(0, 24);
      // Next free id (host always keeps 1).
      let id = 2;
      while (lobby.members.has(id)) id++;

      ws.app = { id, code, name };
      lobby.members.set(id, { ws, name });

      send(ws, {
        type: "joined",
        code,
        id,
        hostId: lobby.hostId,
        name,
        players: [...lobby.members.entries()].map(([pid, m]) => ({ id: pid, name: m.name })),
      });
      // Late join into an already-running game: tell the new player to enter it.
      if (lobby.inGame) send(ws, { type: "start" });
      sendToLobby(lobby, { type: "peer_joined", id, name }, id);
      broadcastLobbyList(wss);
      break;
    }

    case "leave":
      removeFromLobby(ws, wss);
      break;

    case "start": {
      if (!app) return;
      const lobby = lobbies.get(app.code);
      if (!lobby) return;
      if (lobby.hostId !== app.id) return send(ws, { type: "error", message: "not_host" });
      lobby.inGame = true;
      sendToLobby(lobby, { type: "start" });
      broadcastLobbyList(wss);
      break;
    }

    case "signal": {
      if (!app) return;
      const lobby = lobbies.get(app.code);
      if (!lobby) return;
      const to = parseInt(msg.to, 10);
      if (!lobby.members.has(to)) return;
      send(lobby.members.get(to).ws, { type: "signal", from: app.id, data: msg.data });
      break;
    }

    case "ping":
      send(ws, { type: "pong" });
      break;

    default:
      break;
  }
}

function createServer(httpServer) {
  const wss = new WebSocketServer(
    httpServer ? { server: httpServer, clientTracking: true } : { port: PORT, clientTracking: true }
  );

  wss.on("connection", (ws) => {
    ws.app = null;
    ws.isAlive = true;
    ws.on("message", (data) => handleMessage(ws, data.toString(), wss));
    ws.on("close", () => removeFromLobby(ws, wss));
    ws.on("error", () => removeFromLobby(ws, wss));
    ws.on("pong", () => {
      ws.isAlive = true;
    });
  });

  // Keepalive so NAT/proxies don't drop idle signaling sockets.
  const keepalive = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on("close", () => clearInterval(keepalive));

  return wss;
}

module.exports = { attach: createServer };

// Run standalone.
if (require.main === module) {
  createServer();
  console.log(`Lobby server listening on ws://0.0.0.0:${PORT}`);
}
