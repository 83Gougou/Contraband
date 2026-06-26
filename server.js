const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' }
});

app.use(express.static('.'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============= GAME STATE =============
const games = {};
const players = {};

class GameRoom {
  constructor(roomId, settings) {
    this.roomId = roomId;
    this.settings = {
      maxPlayers: settings.maxPlayers || 4,
      totalRounds: settings.totalRounds || 10,
      maxTimePerTurn: settings.maxTimePerTurn || 120,
      smuggleLimit: settings.smuggleLimit || 100,
      startingATM: settings.startingATM || 300
    };
    
    this.players = {};
    this.status = 'lobby'; // lobby, teamSelection, roleSelection, playing, finished
    this.currentRound = 0;
    this.gameHistory = [];
    this.teamA = [];
    this.teamB = [];
    this.currentSmugglerTeam = 'A'; // Which team is smuggling this round
  }

  addPlayer(playerId, name) {
    this.players[playerId] = {
      id: playerId,
      name: name,
      team: null,
      role: null,
      atm: this.settings.startingATM,
      bank: 100,
      totalSmuggled: 0,
      totalIndemnity: 0,
      collectedFromEnemies: 0
    };
    return this.players[playerId];
  }

  getGameState() {
    return {
      roomId: this.roomId,
      status: this.status,
      settings: this.settings,
      currentRound: this.currentRound,
      players: this.players,
      teamA: this.teamA,
      teamB: this.teamB,
      currentSmugglerTeam: this.currentSmugglerTeam,
      playerCount: Object.keys(this.players).length
    };
  }

  getPlayerList() {
    return Object.values(this.players).map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      role: p.role,
      atm: p.atm,
      bank: p.bank
    }));
  }

  setPlayerTeam(playerId, team) {
    if (this.players[playerId]) {
      this.players[playerId].team = team;
      if (team === 'A') {
        this.teamA.push(playerId);
      } else {
        this.teamB.push(playerId);
      }
      return true;
    }
    return false;
  }

  setPlayerRole(playerId, role) {
    if (this.players[playerId]) {
      this.players[playerId].role = role;
      return true;
    }
    return false;
  }

  processTurn(smugglerId, amount, inspectorDecision, doubtAmount) {
    const smuggler = this.players[smugglerId];
    if (!smuggler || amount > this.settings.smuggleLimit || amount > smuggler.atm) {
      return { success: false, error: 'Invalid smuggle amount' };
    }

    // Withdraw from ATM
    smuggler.atm -= amount;
    
    let result = {
      success: true,
      smuggler: smuggler.name,
      amount: amount,
      decision: inspectorDecision,
      indemnity: 0,
      finalAmount: amount
    };

    if (inspectorDecision === 'pass') {
      // Smuggler gets the money to bank
      smuggler.bank += amount;
      smuggler.totalSmuggled += amount;
      result.outcome = 'success';
    } else if (inspectorDecision === 'doubt') {
      // Inspector doubted
      const inspectorTeam = smuggler.team === 'A' ? 'B' : 'A';
      const inspectorPlayers = smuggler.team === 'A' ? this.teamB : this.teamA;

      if (doubtAmount === 0) {
        // Case was empty, inspector pays indemnity
        const indemnity = 0; // No money, so no indemnity
        result.outcome = 'empty_case';
        result.indemnity = indemnity;
      } else if (doubtAmount >= amount) {
        // Inspector called correctly or over
        result.outcome = 'caught';
        result.finalAmount = doubtAmount;
        
        // Distribute caught money to all inspector team members
        const amountPerInspector = Math.floor(doubtAmount / inspectorPlayers.length);
        inspectorPlayers.forEach(inspectorId => {
          if (this.players[inspectorId]) {
            this.players[inspectorId].bank += amountPerInspector;
            this.players[inspectorId].collectedFromEnemies += amountPerInspector;
          }
        });
      } else {
        // Smuggler has more than doubted amount
        const indemnity = Math.floor((doubtAmount) / 2);
        smuggler.bank += amount + indemnity;
        smuggler.totalSmuggled += amount;
        smuggler.totalIndemnity += indemnity;
        result.outcome = 'escaped_with_indemnity';
        result.indemnity = indemnity;
        result.finalAmount = amount + indemnity;
      }
    }

    this.gameHistory.push(result);
    return result;
  }

  finishRound() {
    // Remaining ATM money goes to opposing team
    const teamARemaining = this.teamA.reduce((sum, pId) => sum + this.players[pId].atm, 0);
    const teamBRemaining = this.teamB.reduce((sum, pId) => sum + this.players[pId].atm, 0);

    // Distribute opponent's remaining money
    this.teamA.forEach(pId => {
      this.players[pId].bank += Math.floor(teamBRemaining / this.teamA.length);
    });
    
    this.teamB.forEach(pId => {
      this.players[pId].bank += Math.floor(teamARemaining / this.teamB.length);
    });

    // Reset ATMs for next round
    this.teamA.forEach(pId => {
      this.players[pId].atm = this.settings.startingATM;
    });
    
    this.teamB.forEach(pId => {
      this.players[pId].atm = this.settings.startingATM;
    });

    this.currentRound++;
    this.currentSmugglerTeam = this.currentSmugglerTeam === 'A' ? 'B' : 'A';
  }

  getResults() {
    const results = Object.values(this.players).map(p => ({
      name: p.name,
      team: p.team,
      bank: p.bank,
      atm: p.atm,
      totalSmuggled: p.totalSmuggled,
      totalIndemnity: p.totalIndemnity,
      collectedFromEnemies: p.collectedFromEnemies,
      totalScore: p.bank + p.atm
    }));
    
    return results.sort((a, b) => b.totalScore - a.totalScore);
  }
}

// ============= SOCKET EVENTS =============
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', (data) => {
    const roomId = Math.random().toString(36).substring(7);
    const room = new GameRoom(roomId, data.settings || {});
    games[roomId] = room;
    
    const player = room.addPlayer(socket.id, data.playerName);
    players[socket.id] = { roomId, ...player };
    
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, gameState: room.getGameState() });
    io.to(roomId).emit('gameStateUpdated', room.getGameState());
  });

  socket.on('joinRoom', (data) => {
    const { roomId, playerName } = data;
    const room = games[roomId];
    
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    
    if (Object.keys(room.players).length >= room.settings.maxPlayers) {
      socket.emit('error', 'Room is full');
      return;
    }

    const player = room.addPlayer(socket.id, playerName);
    players[socket.id] = { roomId, ...player };
    socket.join(roomId);
    
    socket.emit('roomJoined', { roomId, gameState: room.getGameState() });
    io.to(roomId).emit('gameStateUpdated', room.getGameState());
  });

  socket.on('selectTeam', (data) => {
    const { roomId, team } = data;
    const room = games[roomId];
    
    if (!room) return;
    room.setPlayerTeam(socket.id, team);
    io.to(roomId).emit('gameStateUpdated', room.getGameState());
  });

  socket.on('selectRole', (data) => {
    const { roomId, role } = data;
    const room = games[roomId];
    
    if (!room) return;
    room.setPlayerRole(socket.id, role);
    io.to(roomId).emit('gameStateUpdated', room.getGameState());
  });

  socket.on('startGame', (roomId) => {
    const room = games[roomId];
    if (!room) return;
    
    room.status = 'playing';
    room.currentRound = 1;
    io.to(roomId).emit('gameStarted', room.getGameState());
  });

  socket.on('submitTurn', (data) => {
    const { roomId, amount, decision, doubtAmount } = data;
    const room = games[roomId];
    
    if (!room) return;
    
    const result = room.processTurn(socket.id, amount, decision, doubtAmount);
    io.to(roomId).emit('turnProcessed', result);
    io.to(roomId).emit('gameStateUpdated', room.getGameState());
  });

  socket.on('finishRound', (roomId) => {
    const room = games[roomId];
    if (!room) return;
    
    room.finishRound();
    
    if (room.currentRound > room.settings.totalRounds) {
      room.status = 'finished';
      const results = room.getResults();
      io.to(roomId).emit('gameFinished', { results, finalState: room.getGameState() });
    } else {
      io.to(roomId).emit('roundFinished', room.getGameState());
    }
  });

  socket.on('disconnect', () => {
    const playerData = players[socket.id];
    if (playerData) {
      const room = games[playerData.roomId];
      if (room) {
        delete room.players[socket.id];
        room.teamA = room.teamA.filter(id => id !== socket.id);
        room.teamB = room.teamB.filter(id => id !== socket.id);
        io.to(playerData.roomId).emit('gameStateUpdated', room.getGameState());
      }
    }
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
