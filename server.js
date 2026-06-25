const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public")); // si tu mets index.html dans /public

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// ---- CONFIG PAR DÉFAUT ----
const DEFAULT_SETTINGS = {
  maxPlayers: 10,
  startingATMPerPlayer: 300_000_000,
  startingThirdCountryPerPlayer: 100_000_000,
  teamMode: true, // true = Nord/Sud, false = FFA
  totalGames: 50,
  loanPerPlayer: 400_000_000
};

// lobbies: { lobbyId: { hostId, players: [], settings, state } }
const lobbies = {};

function createLobby(hostSocketId, hostName, customSettings = {}) {
  const lobbyId = Math.random().toString(36).substring(2, 8);
  const settings = { ...DEFAULT_SETTINGS, ...customSettings };

  lobbies[lobbyId] = {
    id: lobbyId,
    hostId: hostSocketId,
    settings,
    players: [],
    state: {
      currentGame: 1,
      phase: "lobby", // lobby | in-game | finished
      history: []
    }
  };

  const hostPlayer = {
    id: hostSocketId,
    name: hostName || "Host",
    team: null,
    atm: settings.startingATMPerPlayer,
    thirdCountry: settings.startingThirdCountryPerPlayer,
    loan: settings.loanPerPlayer,
    totalOutside: settings.startingThirdCountryPerPlayer,
    connected: true
  };

  lobbies[lobbyId].players.push(hostPlayer);
  return lobbies[lobbyId];
}

function getLobbyBySocket(socketId) {
  return Object.values(lobbies).find(lobby =>
    lobby.players.some(p => p.id === socketId)
  );
}

io.on("connection", (socket) => {
  console.log("New client:", socket.id);

  // Créer un lobby
  socket.on("createLobby", (data, callback) => {
    const { playerName, settings } = data;
    const lobby = createLobby(socket.id, playerName, settings || {});
    socket.join(lobby.id);
    callback({ lobby });
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  // Rejoindre un lobby
  socket.on("joinLobby", (data, callback) => {
    const { lobbyId, playerName } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) {
      return callback({ error: "Lobby introuvable." });
    }
    if (lobby.players.length >= lobby.settings.maxPlayers) {
      return callback({ error: "Lobby plein." });
    }

    const player = {
      id: socket.id,
      name: playerName || "Joueur",
      team: null,
      atm: lobby.settings.startingATMPerPlayer,
      thirdCountry: lobby.settings.startingThirdCountryPerPlayer,
      loan: lobby.settings.loanPerPlayer,
      totalOutside: lobby.settings.startingThirdCountryPerPlayer,
      connected: true
    };

    lobby.players.push(player);
    socket.join(lobby.id);
    callback({ lobby });
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  // Host met à jour les settings
  socket.on("updateSettings", (data) => {
    const lobby = lobbies[data.lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.settings = { ...lobby.settings, ...data.settings };
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  // Assigner les équipes (Nord/Sud)
  socket.on("assignTeams", (data) => {
    const lobby = lobbies[data.lobbyId];
    if (!lobby || !lobby.settings.teamMode) return;
    if (lobby.hostId !== socket.id) return;

    let toggle = true;
    lobby.players.forEach(p => {
      p.team = toggle ? "North" : "South";
      toggle = !toggle;
    });

    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  // Démarrer la partie
  socket.on("startGame", (data) => {
    const lobby = lobbies[data.lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.state.phase = "in-game";
    lobby.state.currentGame = 1;
    io.to(lobby.id).emit("gameStarted", lobby);
  });

  // Choisir smuggler / inspector pour une "game"
  socket.on("setRoles", (data) => {
    const { lobbyId, smugglerId, inspectorId } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    lobby.state.currentRoles = { smugglerId, inspectorId };
    io.to(lobby.id).emit("rolesUpdate", lobby.state.currentRoles);
  });

  // Smuggler prépare un transport
  socket.on("smugglerPrepare", (data) => {
    const { lobbyId, amount } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const roles = lobby.state.currentRoles;
    if (!roles) return;

    const smuggler = lobby.players.find(p => p.id === roles.smugglerId);
    if (!smuggler) return;

    if (amount < 0 || amount > 100_000_000) return;
    if (smuggler.atm < amount) return;

    smuggler.atm -= amount;

    lobby.state.currentBriefcase = {
      amount,
      smugglerId: smuggler.id
    };

    io.to(roles.smugglerId).emit("briefcaseConfirmed", {
      amount
    });
    io.to(roles.inspectorId).emit("briefcaseReady");
  });

  // Inspector call: pass ou doubt
  socket.on("inspectorDecision", (data) => {
    const { lobbyId, decision, doubtAmount } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const roles = lobby.state.currentRoles;
    if (!roles || !lobby.state.currentBriefcase) return;

    const briefcase = lobby.state.currentBriefcase;
    const smuggler = lobby.players.find(p => p.id === roles.smugglerId);
    const inspector = lobby.players.find(p => p.id === roles.inspectorId);

    if (!smuggler || !inspector) return;

    let logEntry = {
      game: lobby.state.currentGame,
      decision,
      doubtAmount: doubtAmount || 0,
      briefcaseAmount: briefcase.amount,
      smugglerId: smuggler.id,
      inspectorId: inspector.id,
      result: null
    };

    if (decision === "pass") {
      // Si pass et il y a de l'argent -> va au Third Country
      if (briefcase.amount > 0) {
        smuggler.thirdCountry += briefcase.amount;
        smuggler.totalOutside += briefcase.amount;
        logEntry.result = "Money passed to Third Country.";
      } else {
        logEntry.result = "Case empty, nothing happens.";
      }
    } else if (decision === "doubt") {
      const called = doubtAmount || 0;
      if (briefcase.amount === 0) {
        // indemnité: moitié du montant appelé va à l'autre pays
        const indemnity = Math.floor(called / 2);
        smuggler.thirdCountry += indemnity;
        smuggler.totalOutside += indemnity;
        logEntry.result = `Case empty, indemnity ${indemnity} to smuggler.`;
      } else {
        if (called >= briefcase.amount) {
          // inspector prend l'argent pour son pays
          inspector.thirdCountry += briefcase.amount;
          inspector.totalOutside += briefcase.amount;
          logEntry.result = `Inspector wins ${briefcase.amount}.`;
        } else {
          // smuggler gagne tout + indemnité
          const indemnity = briefcase.amount - called;
          const totalGain = briefcase.amount + indemnity;
          smuggler.thirdCountry += totalGain;
          smuggler.totalOutside += totalGain;
          logEntry.result = `Smuggler wins ${totalGain} (case + indemnity).`;
        }
      }
    }

    lobby.state.history.push(logEntry);
    lobby.state.currentBriefcase = null;

    io.to(lobby.id).emit("roundResult", logEntry);
  });

  // Passer à la game suivante
  socket.on("nextGame", (data) => {
    const lobby = lobbies[data.lobbyId];
    if (!lobby) return;
    lobby.state.currentGame += 1;

    if (lobby.state.currentGame > lobby.settings.totalGames) {
      // Fin de partie
      lobby.state.phase = "finished";

      // Argent restant dans ATM va à l'autre pays (simplifié: réparti équitablement)
      const totalATM = lobby.players.reduce((sum, p) => sum + p.atm, 0);
      const bonusPerPlayer = Math.floor(totalATM / lobby.players.length);

      lobby.players.forEach(p => {
        p.totalOutside += bonusPerPlayer;
      });

      io.to(lobby.id).emit("gameFinished", {
        lobby,
        totalATM,
        bonusPerPlayer
      });
    } else {
      io.to(lobby.id).emit("gameCounterUpdate", lobby.state.currentGame);
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    const lobby = getLobbyBySocket(socket.id);
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (player) player.connected = false;

    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
