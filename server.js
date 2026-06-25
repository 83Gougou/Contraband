const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// État du jeu
const rooms = {};
const playerSockets = {}; // socketId -> roomId

class GameRoom {
  constructor(roomId, maxPlayers = 10) {
    this.roomId = roomId;
    this.maxPlayers = maxPlayers;
    this.players = [];
    this.teams = { north: [], south: [] };
    this.gameState = 'lobby'; // lobby, active, game_end
    this.currentGameNumber = 0;
    this.maxGames = 50;
    this.currentSmugglerTeam = 'north';
    this.customsInspector = null;
    this.currentSmuggler = null;
    this.briefcaseAmount = 0;
  }

  addPlayer(playerId, username) {
    if (this.players.length >= this.maxPlayers) return false;
    if (this.players.find(p => p.id === playerId)) return true; // déjà présent
    this.players.push({
      id: playerId,
      username: username,
      team: null,
      atm: 300_000_000,
      thirdCountry: 100_000_000,
      totalEarned: 0,
      smuggled: 0,
      indemnities: 0
    });
    return true;
  }

  removePlayer(playerId) {
    this.players = this.players.filter(p => p.id !== playerId);
    this.teams.north = this.teams.north.filter(p => p.id !== playerId);
    this.teams.south = this.teams.south.filter(p => p.id !== playerId);
  }

  // Assigne les équipes sans démarrer la partie (phase setup)
  setTeams(teamConfig) {
    // Réinitialiser les équipes dans les objets joueurs
    for (const player of this.players) {
      if (teamConfig.north.includes(player.id)) {
        player.team = 'north';
      } else if (teamConfig.south.includes(player.id)) {
        player.team = 'south';
      } else {
        player.team = null;
      }
    }
    this.teams.north = this.players.filter(p => p.team === 'north');
    this.teams.south = this.players.filter(p => p.team === 'south');
  }

  // Démarre la partie
  startGame() {
    this.gameState = 'active';
    this.currentGameNumber = 0;
    this.nextGame();
  }

  processCustomsResult(doubt, caseAmount) {
    const result = {
      doubt: doubt,
      caseAmount: caseAmount,
      outcome: null,
      moneyTransferred: 0,
      indemnity: 0
    };

    const inspectorTeam = this.currentSmugglerTeam === 'north' ? 'south' : 'north';
    const inspectorTeamPlayers = this.teams[inspectorTeam];

    if (doubt === null) {
      // Laissé passer — l'argent passe
      result.outcome = 'pass';
      result.moneyTransferred = caseAmount;
      this.currentSmuggler.thirdCountry += caseAmount;
      this.currentSmuggler.smuggled += caseAmount;
    } else if (caseAmount === 0 && doubt === 0) {
      // Valise vide, laissé passer
      result.outcome = 'pass_empty';
    } else if (caseAmount === 0 && doubt > 0) {
      // Doute sur une valise vide → indemnité pour le contrebandier
      result.outcome = 'indemnity';
      result.indemnity = Math.floor(doubt / 2);
      this.currentSmuggler.thirdCountry += result.indemnity;
      this.currentSmuggler.indemnities += result.indemnity;
    } else if (doubt > caseAmount) {
      // Doute supérieur au montant → l'inspecteur gagne
      result.outcome = 'doubt_wins';
      result.moneyTransferred = caseAmount;
      if (inspectorTeamPlayers.length > 0) {
        const perPlayer = caseAmount / inspectorTeamPlayers.length;
        inspectorTeamPlayers.forEach(p => p.atm += perPlayer);
      }
    } else if (doubt === caseAmount && caseAmount > 0) {
      // Doute exact → l'inspecteur gagne
      result.outcome = 'exact_doubt';
      result.moneyTransferred = caseAmount;
      if (inspectorTeamPlayers.length > 0) {
        const perPlayer = caseAmount / inspectorTeamPlayers.length;
        inspectorTeamPlayers.forEach(p => p.atm += perPlayer);
      }
    } else if (doubt > 0 && doubt < caseAmount) {
      // Doute inférieur au montant → contrebandier gagne + indemnité
      result.outcome = 'smuggler_wins';
      result.moneyTransferred = caseAmount;
      result.indemnity = Math.floor(doubt / 2);
      this.currentSmuggler.thirdCountry += caseAmount + result.indemnity;
      this.currentSmuggler.smuggled += caseAmount;
      this.currentSmuggler.indemnities += result.indemnity;
    }

    return result;
  }

  nextGame() {
    this.currentGameNumber++;

    if (this.currentGameNumber > this.maxGames) {
      this.endGame();
      return false;
    }

    // Alternance des équipes : impair → Nord contrebande, pair → Sud contrebande
    this.currentSmugglerTeam = this.currentGameNumber % 2 === 1 ? 'north' : 'south';
    this.currentSmuggler = null;
    this.customsInspector = null;
    this.briefcaseAmount = 0;

    return true;
  }

  endGame() {
    // L'argent restant dans les guichets va à l'équipe adverse
    for (const team of ['north', 'south']) {
      const otherTeam = team === 'north' ? 'south' : 'north';
      const otherPlayers = this.teams[otherTeam];
      if (otherPlayers.length === 0) continue;

      let totalAtm = 0;
      for (const player of this.teams[team]) {
        totalAtm += player.atm;
      }

      const perPlayer = Math.floor(totalAtm / otherPlayers.length);
      otherPlayers.forEach(p => p.totalEarned += perPlayer);
    }

    // Calcul des gains finaux pour chaque joueur
    for (const player of this.players) {
      player.totalEarned += player.thirdCountry - 100_000_000; // Bénéfice pays tiers
      player.totalEarned -= 300_000_000; // Remboursement du prêt ATM
    }

    this.gameState = 'game_end';
  }

  getGameState() {
    return {
      roomId: this.roomId,
      gameState: this.gameState,
      players: this.players.map(p => ({
        id: p.id,
        username: p.username,
        team: p.team,
        atm: p.atm,
        thirdCountry: p.thirdCountry,
        totalEarned: p.totalEarned
      })),
      teams: {
        north: this.teams.north.map(p => p.username),
        south: this.teams.south.map(p => p.username)
      },
      currentGameNumber: this.currentGameNumber,
      maxGames: this.maxGames,
      currentSmugglerTeam: this.currentSmugglerTeam,
      customsInspector: this.customsInspector?.username || null,
      currentSmuggler: this.currentSmuggler?.username || null
    };
  }
}

io.on('connection', (socket) => {
  console.log('Joueur connecté :', socket.id);

  socket.on('create_room', (data) => {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    rooms[roomId] = new GameRoom(roomId, data.maxPlayers || 10);
    rooms[roomId].addPlayer(socket.id, data.username);
    playerSockets[socket.id] = roomId;

    socket.join(roomId);
    socket.emit('room_created', { roomId, gameState: rooms[roomId].getGameState() });
    console.log(`Salle créée : ${roomId} par ${data.username}`);
  });

  socket.on('join_room', (data) => {
    const roomId = data.roomId.toUpperCase();
    if (!rooms[roomId]) {
      socket.emit('error', 'Salle introuvable');
      return;
    }
    if (rooms[roomId].gameState !== 'lobby') {
      socket.emit('error', 'La partie est déjà commencée');
      return;
    }
    if (!rooms[roomId].addPlayer(socket.id, data.username)) {
      socket.emit('error', 'La salle est pleine');
      return;
    }

    playerSockets[socket.id] = roomId;
    socket.join(roomId);

    // Envoyer l'état initial au joueur qui vient de rejoindre
    socket.emit('joined_room', { roomId, gameState: rooms[roomId].getGameState() });
    // Notifier les autres
    socket.to(roomId).emit('game_update', rooms[roomId].getGameState());
    console.log(`${data.username} a rejoint la salle ${roomId}`);
  });

  // Assigner les équipes en phase de setup (sans démarrer)
  socket.on('assign_teams_setup', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId] || rooms[roomId].gameState !== 'lobby') return;

    rooms[roomId].setTeams(data.teams);
    io.to(roomId).emit('game_update', rooms[roomId].getGameState());
  });

  // Démarrer la partie
  socket.on('start_game', () => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId] || rooms[roomId].gameState !== 'lobby') return;

    const { north, south } = rooms[roomId].teams;
    if (north.length === 0 || south.length === 0) {
      socket.emit('error', 'Les deux équipes doivent avoir au moins 1 joueur');
      return;
    }

    rooms[roomId].startGame();
    io.to(roomId).emit('game_update', rooms[roomId].getGameState());
    console.log(`Partie démarrée dans la salle ${roomId}`);
  });

  socket.on('set_smuggler', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId] || rooms[roomId].gameState !== 'active') return;

    const player = rooms[roomId].players.find(p => p.id === data.playerId);
    if (player && player.team === rooms[roomId].currentSmugglerTeam) {
      rooms[roomId].currentSmuggler = player;
      io.to(roomId).emit('game_update', rooms[roomId].getGameState());
    }
  });

  socket.on('set_customs_inspector', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId] || rooms[roomId].gameState !== 'active') return;

    const player = rooms[roomId].players.find(p => p.id === data.playerId);
    const inspectorTeam = rooms[roomId].currentSmugglerTeam === 'north' ? 'south' : 'north';

    if (player && player.team === inspectorTeam) {
      rooms[roomId].customsInspector = player;
      io.to(roomId).emit('game_update', rooms[roomId].getGameState());
    }
  });

  socket.on('enter_customs', (data) => {
    const roomId = playerSockets[socket.id];
    const room = rooms[roomId];
    if (!room || room.gameState !== 'active') return;
    if (!room.currentSmuggler || !room.customsInspector) {
      socket.emit('error', 'Les deux rôles doivent être sélectionnés avant d\'entrer aux douanes');
      return;
    }

    room.briefcaseAmount = Math.max(0, Math.min(data.amount, 100_000_000));

    io.to(roomId).emit('customs_session_started', {
      smuggler: room.currentSmuggler.username,
      inspector: room.customsInspector.username
    });
  });

  socket.on('customs_pass', () => {
    const roomId = playerSockets[socket.id];
    const room = rooms[roomId];
    if (!room || room.gameState !== 'active') return;

    const result = room.processCustomsResult(null, room.briefcaseAmount);
    io.to(roomId).emit('customs_result', result);

    if (room.nextGame()) {
      io.to(roomId).emit('game_update', room.getGameState());
    } else {
      io.to(roomId).emit('game_update', room.getGameState());
    }
  });

  socket.on('customs_doubt', (data) => {
    const roomId = playerSockets[socket.id];
    const room = rooms[roomId];
    if (!room || room.gameState !== 'active') return;

    const doubtAmount = Math.max(0, Math.min(data.amount, 100_000_000));
    const result = room.processCustomsResult(doubtAmount, room.briefcaseAmount);
    io.to(roomId).emit('customs_result', result);

    if (room.nextGame()) {
      io.to(roomId).emit('game_update', room.getGameState());
    } else {
      io.to(roomId).emit('game_update', room.getGameState());
    }
  });

  socket.on('disconnect', () => {
    const roomId = playerSockets[socket.id];
    if (rooms[roomId]) {
      rooms[roomId].removePlayer(socket.id);

      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
        console.log(`Salle ${roomId} supprimée (vide)`);
      } else {
        io.to(roomId).emit('game_update', rooms[roomId].getGameState());
      }
    }

    delete playerSockets[socket.id];
    console.log('Joueur déconnecté :', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
