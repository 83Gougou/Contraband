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

// Game state
const rooms = {};
const playerSockets = {};

class GameRoom {
  constructor(roomId, maxPlayers = 10) {
    this.roomId = roomId;
    this.maxPlayers = maxPlayers;
    this.players = [];
    this.teams = { north: [], south: [] };
    this.gameState = 'lobby'; // lobby, setup, active, round_end, game_end
    this.currentGameNumber = 0;
    this.maxGames = 50;
    this.currentSmugglerTeam = 'north'; // which team's smuggler is going
    this.customsInspector = null;
    this.currentSmuggler = null;
    this.briefcaseAmount = 0;
    this.customsTimer = null;
    this.gameStartTime = null;
    this.roundHistory = [];
  }

  addPlayer(playerId, username) {
    if (this.players.length >= this.maxPlayers) return false;
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

  assignTeams(teamConfig) {
    // teamConfig: { north: [playerId, ...], south: [playerId, ...] }
    this.teams = { north: [], south: [] };
    
    for (let player of this.players) {
      if (teamConfig.north.includes(player.id)) {
        player.team = 'north';
        this.teams.north.push(player);
      } else if (teamConfig.south.includes(player.id)) {
        player.team = 'south';
        this.teams.south.push(player);
      }
    }
  }

  processCustomsResult(doubt, caseAmount) {
    const result = {
      doubt: doubt,
      caseAmount: caseAmount,
      outcome: null,
      moneyTransferred: 0,
      indemnity: 0
    };

    if (doubt === null) {
      // Pass - money goes through
      result.outcome = 'pass';
      result.moneyTransferred = caseAmount;
      this.currentSmuggler.thirdCountry += caseAmount;
      this.currentSmuggler.smuggled += caseAmount;
    } else if (doubt > caseAmount && caseAmount > 0) {
      // Doubt exceeds amount - inspector takes it
      result.outcome = 'doubt_wins';
      result.moneyTransferred = caseAmount;
      const inspectorTeam = this.currentSmugglerTeam === 'north' ? 'south' : 'north';
      this.teams[inspectorTeam].forEach(p => p.atm += caseAmount / this.teams[inspectorTeam].length);
    } else if (doubt === 0 && caseAmount === 0) {
      // Pass on empty case
      result.outcome = 'pass_empty';
    } else if (doubt > 0 && caseAmount === 0) {
      // Doubt on empty case - indemnity to smuggler
      result.outcome = 'indemnity';
      result.indemnity = Math.floor(doubt / 2);
      this.currentSmuggler.thirdCountry += result.indemnity;
      this.currentSmuggler.indemnities += result.indemnity;
    } else if (doubt > 0 && doubt < caseAmount) {
      // Doubt less than amount - smuggler wins + indemnity
      result.outcome = 'smuggler_wins';
      result.moneyTransferred = caseAmount;
      result.indemnity = Math.floor(doubt / 2);
      this.currentSmuggler.thirdCountry += caseAmount + result.indemnity;
      this.currentSmuggler.smuggled += caseAmount;
      this.currentSmuggler.indemnities += result.indemnity;
    } else if (doubt === caseAmount && caseAmount > 0) {
      // Exact doubt - inspector takes it
      result.outcome = 'exact_doubt';
      result.moneyTransferred = caseAmount;
      const inspectorTeam = this.currentSmugglerTeam === 'north' ? 'south' : 'north';
      this.teams[inspectorTeam].forEach(p => p.atm += caseAmount / this.teams[inspectorTeam].length);
    }

    return result;
  }

  nextGame() {
    this.currentGameNumber++;
    
    if (this.currentGameNumber > this.maxGames) {
      this.endRound();
      return false;
    }

    // Switch roles
    if (this.currentGameNumber % 2 === 1) {
      this.currentSmugglerTeam = 'south';
    } else {
      this.currentSmugglerTeam = 'north';
    }

    this.currentSmuggler = null;
    this.customsInspector = null;
    this.briefcaseAmount = 0;

    return true;
  }

  endRound() {
    // Give remaining ATM money to other team
    for (let team of Object.keys(this.teams)) {
      const otherTeam = team === 'north' ? 'south' : 'north';
      let totalAtm = 0;
      for (let player of this.teams[team]) {
        totalAtm += player.atm;
      }
      
      const perPlayer = Math.floor(totalAtm / this.teams[otherTeam].length);
      for (let player of this.teams[otherTeam]) {
        player.totalEarned += perPlayer;
      }
    }

    // Calculate final earnings
    for (let player of this.players) {
      player.totalEarned += player.smuggled + player.indemnities + player.thirdCountry - 100_000_000;
      player.totalEarned -= 400_000_000; // Loan repayment
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
  console.log('Player connected:', socket.id);

  socket.on('create_room', (data) => {
    const roomId = Math.random().toString(36).substr(2, 9);
    rooms[roomId] = new GameRoom(roomId, data.maxPlayers || 10);
    rooms[roomId].addPlayer(socket.id, data.username);
    playerSockets[socket.id] = roomId;
    
    socket.join(roomId);
    socket.emit('room_created', { roomId, gameState: rooms[roomId].getGameState() });
  });

  socket.on('join_room', (data) => {
    const roomId = data.roomId;
    if (!rooms[roomId]) {
      socket.emit('error', 'Room not found');
      return;
    }
    
    if (!rooms[roomId].addPlayer(socket.id, data.username)) {
      socket.emit('error', 'Room is full');
      return;
    }

    playerSockets[socket.id] = roomId;
    socket.join(roomId);
    io.to(roomId).emit('game_update', rooms[roomId].getGameState());
  });

  socket.on('assign_teams', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId]) return;

    rooms[roomId].assignTeams(data.teams);
    rooms[roomId].gameState = 'active';
    rooms[roomId].nextGame();
    io.to(roomId).emit('game_update', rooms[roomId].getGameState());
  });

  socket.on('set_smuggler', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId]) return;

    const player = rooms[roomId].players.find(p => p.id === data.playerId);
    if (player && player.team === rooms[roomId].currentSmugglerTeam) {
      rooms[roomId].currentSmuggler = player;
      io.to(roomId).emit('game_update', rooms[roomId].getGameState());
    }
  });

  socket.on('set_customs_inspector', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId]) return;

    const player = rooms[roomId].players.find(p => p.id === data.playerId);
    const otherTeam = rooms[roomId].currentSmugglerTeam === 'north' ? 'south' : 'north';
    
    if (player && player.team === otherTeam) {
      rooms[roomId].customsInspector = player;
      io.to(roomId).emit('game_update', rooms[roomId].getGameState());
    }
  });

  socket.on('withdraw_money', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId]) return;

    const player = rooms[roomId].players.find(p => p.id === socket.id);
    if (player && player.atm >= data.amount) {
      player.atm -= data.amount;
      socket.emit('money_withdrawn', { amount: data.amount });
    }
  });

  socket.on('enter_customs', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId]) return;

    rooms[roomId].briefcaseAmount = Math.min(data.amount, 100_000_000);
    
    // Notify both players
    if (rooms[roomId].currentSmuggler) {
      io.to(roomId).emit('customs_session_started', {
        smuggler: rooms[roomId].currentSmuggler.username,
        inspector: rooms[roomId].customsInspector.username
      });
    }
  });

  socket.on('customs_pass', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId]) return;

    const result = rooms[roomId].processCustomsResult(null, rooms[roomId].briefcaseAmount);
    io.to(roomId).emit('customs_result', result);
    
    if (rooms[roomId].nextGame()) {
      io.to(roomId).emit('game_update', rooms[roomId].getGameState());
    }
  });

  socket.on('customs_doubt', (data) => {
    const roomId = playerSockets[socket.id];
    if (!rooms[roomId]) return;

    const result = rooms[roomId].processCustomsResult(data.amount, rooms[roomId].briefcaseAmount);
    io.to(roomId).emit('customs_result', result);
    
    if (rooms[roomId].nextGame()) {
      io.to(roomId).emit('game_update', rooms[roomId].getGameState());
    }
  });

  socket.on('disconnect', () => {
    const roomId = playerSockets[socket.id];
    if (rooms[roomId]) {
      rooms[roomId].removePlayer(socket.id);
      
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
      } else {
        io.to(roomId).emit('game_update', rooms[roomId].getGameState());
      }
    }
    
    delete playerSockets[socket.id];
    console.log('Player disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
