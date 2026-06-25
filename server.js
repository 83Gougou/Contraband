const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Sert index.html
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// --- LOBBYS ---
let lobbys = {}; // { lobbyCode: { players: [], settings: {...}, gameState: {...} } }

// Génère un code de lobby
function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

io.on("connection", (socket) => {
  console.log("Nouveau joueur :", socket.id);

  // Créer un lobby
  socket.on("createLobby", (settings) => {
    const code = generateCode();

    lobbys[code] = {
      players: [],
      settings,
      gameState: {
        started: false,
        currentGame: 1,
        briefcase: 0,
        currentTeam: null,
        currentRole: null,
        teams: {
          nord: { atm: settings.startATM * 3, third: settings.startThird * 3 },
          sud: { atm: settings.startATM * 3, third: settings.startThird * 3 }
        }
      }
    };

    socket.join(code);
    lobbys[code].players.push({ id: socket.id, name: settings.playerName });

    socket.emit("lobbyCreated", code);
    io.to(code).emit("lobbyUpdate", lobbys[code]);
  });

  // Rejoindre un lobby
  socket.on("joinLobby", ({ code, playerName }) => {
    if (!lobbys[code]) {
      socket.emit("errorMessage", "Lobby introuvable.");
      return;
    }

    socket.join(code);
    lobbys[code].players.push({ id: socket.id, name: playerName });

    io.to(code).emit("lobbyUpdate", lobbys[code]);
  });

  // Action du passeur
  socket.on("smugglerAction", ({ code, withdraw, carry }) => {
    const lobby = lobbys[code];
    if (!lobby) return;

    const team = lobby.gameState.currentTeam;
    const t = lobby.gameState.teams[team];

    t.atm -= withdraw;
    lobby.gameState.briefcase = carry;

    io.to(code).emit("gameUpdate", lobby.gameState);
  });

  // Action du douanier
  socket.on("customsAction", ({ code, type, doubtAmount }) => {
    const lobby = lobbys[code];
    if (!lobby) return;

    const gs = lobby.gameState;
    const caseAmount = gs.briefcase;

    const customsTeam = gs.currentTeam;
    const smugglerTeam = customsTeam === "nord" ? "sud" : "nord";

    if (type === "pass") {
      if (caseAmount > 0) {
        lobby.gameState.teams[smugglerTeam].third += caseAmount;
      }
    } else if (type === "doubt") {
      if (caseAmount === 0) {
        const indemnity = Math.floor(doubtAmount / 2);
        lobby.gameState.teams[smugglerTeam].third += indemnity;
      } else if (doubtAmount >= caseAmount) {
        lobby.gameState.teams[customsTeam].atm += caseAmount;
      } else {
        const indemnity = Math.floor(doubtAmount / 2);
        lobby.gameState.teams[smugglerTeam].third += caseAmount + indemnity;
      }
    }

    gs.briefcase = 0;
    gs.currentRole = null;
    gs.currentTeam = null;

    gs.currentGame++;

    io.to(code).emit("gameUpdate", gs);
  });

  socket.on("disconnect", () => {
    console.log("Déconnexion :", socket.id);
  });
});

server.listen(PORT, () => {
  console.log("Serveur lancé sur le port", PORT);
});
