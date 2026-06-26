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
      smuggleLimit: settings.smuggleLimit || 100,
      startingATM: settings.startingATM || 300
    };
    
    this.players = {};
    this.status = 'teamSelection'; // teamSelection, playing, finished
    this.currentRound = 0;
    this.gameHistory = [];
    this.teamA = [];
    this.teamB = [];
    this.currentSmugglerTeam = 'A';
    this.currentTurnData = null;
    this.smugglerIndex = 0; // Track position in team for rotation
    this.inspectorIndex = 0;
  }

  addPlayer(playerId, name) {
    this.players[playerId] = {
      id: playerId,
      name: name,
      team: null,
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
      playerCount: Object.keys(this.players).length,
      currentTurnData: this.currentTurnData,
      gameHistory: this.gameHistory
    };
  }

  setPlayerTeam(playerId, team) {
    if (!this.players[playerId]) return false;
    
    // Remove from old team
    if (this.players[playerId].team === 'A') {
      this.teamA = this.teamA.filter(id => id !== playerId);
    } else if (this.players[playerId].team === 'B') {
      this.teamB = this.teamB.filter(id => id !== playerId);
    }
    
    // Add to new team
    this.players[playerId].team = team;
    if (team === 'A') {
      this.teamA.push(playerId);
    } else if (team === 'B') {
      this.teamB.push(playerId);
    }
    
    return true;
  }

  allPlayersHaveTeams() {
    const count = Object.keys(this.players).length;
    return count >= 2 && Object.values(this.players).every(p => p.team !== null);
  }

  startGame() {
    this.status = 'playing';
    this.currentRound = 1;
    this.selectCurrentTurn();
  }

  selectCurrentTurn() {
    const smugglingTeam = this.currentSmugglerTeam === 'A' ? this.teamA : this.teamB;
    const inspectingTeam = this.currentSmugglerTeam === 'A' ? this.teamB : this.teamA;
    
    // Rotate through smugglers
    const smuggler = smugglingTeam[this.smugglerIndex % smugglingTeam.length];
    this.smugglerIndex++;
    
    // Rotate through inspectors
    const inspector = inspectingTeam[this.inspectorIndex % inspectingTeam.length];
    this.inspectorIndex++;
    
    this.currentTurnData = {
      smugglerId: smuggler,
      inspectorId: inspector,
      smugglerSubmitted: false,
      inspectorSubmitted: false,
      amount: null,
      decision: null,
      doubtAmount: null
    };
  }

  submitSmugglerAmount(playerId, amount) {
    if (!this.currentTurnData || this.currentTurnData.smugglerId !== playerId) {
      return { success: false, error: 'Not your turn' };
    }

    if (this.currentTurnData.smugglerSubmitted) {
      return { success: false, error: 'Already submitted' };
    }

    const smuggler = this.players[playerId];
    if (!smuggler || amount < 0 || amount > this.settings.smuggleLimit || amount > smuggler.atm) {
      return { success: false, error: 'Invalid amount' };
    }

    this.currentTurnData.amount = amount;
    this.currentTurnData.smugglerSubmitted = true;
    return { success: true };
  }

  submitInspectorDecision(playerId, decision, doubtAmount) {
    if (!this.currentTurnData || this.currentTurnData.inspectorId !== playerId) {
      return { success: false, error: 'Not your turn' };
    }

    if (this.currentTurnData.inspectorSubmitted) {
      return { success: false, error: 'Already submitted' };
    }

    if (decision === 'doubt') {
      if (doubtAmount < 0 || doubtAmount > 100) {
        return { success: false, error: 'Invalid doubt amount' };
      }
      this.currentTurnData.doubtAmount = doubtAmount;
    }

    this.currentTurnData.decision = decision;
    this.currentTurnData.inspectorSubmitted = true;
    return { success: true };
  }

  processTurn() {
    if (!this.currentTurnData.smugglerSubmitted || !this.currentTurnData.inspectorSubmitted) {
      return null;
    }

    const smuggler = this.players[this.currentTurnData.smugglerId];
    const inspector = this.players[this.currentTurnData.inspectorId];
    const amount = this.currentTurnData.amount;
    const decision = this.currentTurnData.decision;
    const doubtAmount = this.currentTurnData.doubtAmount;

    if (!smuggler || !inspector) {
      return null;
    }

    // Withdraw from ATM
    smuggler.atm -= amount;
    
    let result = {
      smugglerName: smuggler.name,
      inspectorName: inspector.name,
      amount: amount,
      decision: decision,
      outcome: null,
      message: ''
    };

    if (decision === 'pass') {
      smuggler.bank += amount;
      smuggler.totalSmuggled += amount;
      result.outcome = 'passed';
      result.message = `✈️ ${smuggler.name} a passé avec ${amount}!`;
    } else if (decision === 'doubt') {
      if (doubtAmount > amount) {
        // Smuggler escaped with indemnity
        const indemnity = Math.floor(doubtAmount / 2);
        smuggler.bank += amount + indemnity;
        smuggler.totalSmuggled += amount;
        smuggler.totalIndemnity += indemnity;
        result.outcome = 'escaped';
        result.indemnity = indemnity;
        result.message = `💰 ${smuggler.name} a échappé! ${amount} + ${indemnity} indemnité`;
      } else {
        // Inspector caught it
        inspector.bank += amount;
        inspector.collectedFromEnemies += amount;
        result.outcome = 'caught';
        result.message = `🚨 ${inspector.name} a attrapé ${smuggler.name}! +${amount}`;
      }
    }

    this.gameHistory.push(result);
    return result;
  }

  nextTurn() {
    this.currentRound++;
    if (this.currentRound > this.settings.totalRounds) {
      this.status = 'finished';
      return false;
    }

    // Switch which team is smuggling
    this.currentSmugglerTeam = this.currentSmugglerTeam === 'A' ? 'B' : 'A';
    
    // Reset indices when switching teams (so we start fresh with new team)
    this.smugglerIndex = 0;
    this.inspectorIndex = 0;
    
    this.selectCurrentTurn();
    return true;
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
    const roomId = Math.random().toString(36).substring(7).toUpperCase();
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

  socket.on('startGame', (roomId) => {
    const room = games[roomId];
    if (!room || !room.allPlayersHaveTeams()) {
      socket.emit('error', 'Not all players have selected teams');
      return;
    }
    
    room.startGame();
    io.to(roomId).emit('gameStarted', room.getGameState());
  });

  socket.on('submitSmugglerAmount', (data) => {
    const { roomId, amount } = data;
    const room = games[roomId];
    
    if (!room) return;
    
    const result = room.submitSmugglerAmount(socket.id, amount);
    if (!result.success) {
      socket.emit('error', result.error);
      return;
    }

    io.to(roomId).emit('gameStateUpdated', room.getGameState());
    io.to(roomId).emit('notification', `📦 Le smuggleur a préparer sa valise...`);
  });

  socket.on('submitInspectorDecision', (data) => {
    const { roomId, decision, doubtAmount } = data;
    const room = games[roomId];
    
    if (!room) return;
    
    const result = room.submitInspectorDecision(socket.id, decision, doubtAmount);
    if (!result.success) {
      socket.emit('error', result.error);
      return;
    }

    // Both submitted, process turn
    if (room.currentTurnData.smugglerSubmitted && room.currentTurnData.inspectorSubmitted) {
      const turnResult = room.processTurn();
      io.to(roomId).emit('turnCompleted', turnResult);
      io.to(roomId).emit('gameStateUpdated', room.getGameState());
    }
  });

  socket.on('nextTurn', (roomId) => {
    const room = games[roomId];
    if (!room) return;
    
    const hasMore = room.nextTurn();
    
    if (!hasMore) {
      const results = room.getResults();
      const finalState = room.getGameState();
      finalState.results = results;
      io.to(roomId).emit('gameFinished', { results, finalState });
    } else {
      io.to(roomId).emit('gameStateUpdated', room.getGameState());
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
