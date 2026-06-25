const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public")); // mets index.html dans /public

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const DEFAULT_SETTINGS = {
  maxPlayers: 10,
  startingATMPerPlayer: 300_000_000,
  startingThirdCountryPerPlayer: 100_000_000,
  teamMode: true,
  totalGames: 50,
  loanPerPlayer: 400_000_000
};

const lobbies = {};

function createLobby(hostSocketId, hostName, customSettings = {}) {
  const lobbyId = Math.random().toString(36).substring(2, 8);
  const settings = { ...DEFAULT_SETTINGS, ...customSettings };

  const lobby = {
    id: lobbyId,
    hostId: hostSocketId,
    settings,
    players: [],
    state: {
      phase: "lobby", // lobby | in-game | finished
      currentGame: 1,
      currentRoles: null,
      currentBriefcase: null,
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

  lobby.players.push(hostPlayer);
  lobbies[lobbyId] = lobby;
  return lobby;
}

function getLobbyBySocket(socketId) {
  return Object.values(lobbies).find(lobby =>
    lobby.players.some(p => p.id === socketId)
  );
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("createLobby", (data, cb) => {
    const { playerName, settings } = data;
    const lobby = createLobby(socket.id, playerName, settings || {});
    socket.join(lobby.id);
    cb({ lobby, isHost: true });
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  socket.on("joinLobby", (data, cb) => {
    const { lobbyId, playerName } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) return cb({ error: "Lobby introuvable." });
    if (lobby.players.length >= lobby.settings.maxPlayers) {
      return cb({ error: "Lobby plein." });
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
    cb({ lobby, isHost: lobby.hostId === socket.id });
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  socket.on("updateSettings", (data) => {
    const { lobbyId, settings } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.settings = { ...lobby.settings, ...settings };
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  socket.on("assignTeams", (data) => {
    const { lobbyId } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    if (!lobby.settings.teamMode) return;

    let toggle = true;
    lobby.players.forEach(p => {
      p.team = toggle ? "North" : "South";
      toggle = !toggle;
    });

    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  socket.on("startGame", (data) => {
    const { lobbyId } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.state.phase = "in-game";
    lobby.state.currentGame = 1;
    io.to(lobby.id).emit("gameStarted", lobby);
  });

  socket.on("setRoles", (data) => {
    const { lobbyId, smugglerId, inspectorId } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;

    lobby.state.currentRoles = { smugglerId, inspectorId };
    io.to(lobby.id).emit("rolesUpdate", lobby.state.currentRoles);
  });

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

    io.to(roles.smugglerId).emit("briefcaseConfirmed", { amount });
    io.to(roles.inspectorId).emit("briefcaseReady");
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  socket.on("inspectorDecision", (data) => {
    const { lobbyId, decision, doubtAmount } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const roles = lobby.state.currentRoles;
    const briefcase = lobby.state.currentBriefcase;
    if (!roles || !briefcase) return;

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
      result: ""
    };

    if (decision === "pass") {
      if (briefcase.amount > 0) {
        smuggler.thirdCountry += briefcase.amount;
        smuggler.totalOutside += briefcase.amount;
        logEntry.result = `PASS → ${briefcase.amount} yen passent au Third Country.`;
      } else {
        logEntry.result = "PASS → valise vide.";
      }
    } else if (decision === "doubt") {
      const called = doubtAmount || 0;
      if (briefcase.amount === 0) {
        const indemnity = Math.floor(called / 2);
        smuggler.thirdCountry += indemnity;
        smuggler.totalOutside += indemnity;
        logEntry.result = `DOUBT sur valise vide → indemnité ${indemnity} au smuggler.`;
      } else {
        if (called >= briefcase.amount) {
          inspector.thirdCountry += briefcase.amount;
          inspector.totalOutside += briefcase.amount;
          logEntry.result = `DOUBT ≥ contenu → inspector gagne ${briefcase.amount}.`;
        } else {
          const indemnity = briefcase.amount - called;
          const totalGain = briefcase.amount + indemnity;
          smuggler.thirdCountry += totalGain;
          smuggler.totalOutside += totalGain;
          logEntry.result = `DOUBT < contenu → smuggler gagne ${totalGain} (valise + indemnité).`;
        }
      }
    }

    lobby.state.history.push(logEntry);
    lobby.state.currentBriefcase = null;

    io.to(lobby.id).emit("roundResult", logEntry);
    io.to(lobby.id).emit("lobbyUpdate", lobby);
  });

  socket.on("nextGame", (data) => {
    const { lobbyId } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    lobby.state.currentGame += 1;

    if (lobby.state.currentGame > lobby.settings.totalGames) {
      lobby.state.phase = "finished";

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
