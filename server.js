const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'https://echoes.narju.net',
  'http://echoes.narju.net',
  'https://echoesgame.netlify.app'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ["GET", "POST"]
};

const io = socketIo(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// In-memory storage (replace with database later)
const rooms = new Map();
const users = new Map();
const socketToPlayer = new Map(); // Track which socket belongs to which player

// Basic health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Echoes backend is running' });
});

// Room management API
app.get('/api/rooms', (req, res) => {
  const availableRooms = Array.from(rooms.values())
    .filter(room => room.status === 'waiting')
    .map(room => ({
      id: room.id,
      host: room.host,
      createdAt: room.createdAt,
      playerCount: room.players.length
    }));
  
  console.log(`GET /api/rooms - Returning ${availableRooms.length} available rooms`);
  if (availableRooms.length > 0) {
    availableRooms.forEach(room => {
      console.log(`  - Room ${room.id}: ${room.playerCount}/2 players, host: ${room.host}`);
    });
  }
  
  res.json(availableRooms);
});

app.post('/api/rooms', (req, res) => {
  const { playerName } = req.body;
  
  if (!playerName) {
    return res.status(400).json({ error: 'Player name is required' });
  }

  // Check if player name is valid (not empty, reasonable length, etc.)
  if (playerName.trim().length === 0 || playerName.length > 20) {
    return res.status(400).json({ error: 'Player name must be between 1 and 20 characters' });
  }

  const roomId = generateRoomId();
  const playerId = generateUserId();
  const room = {
    id: roomId,
    host: playerName,
    status: 'waiting',
    players: [{ id: playerId, name: playerName, isHost: true, gamePlayerId: 'player1' }],
    createdAt: new Date(),
    gameState: null
  };

  rooms.set(roomId, room);
  
  console.log(`ROOM CREATED: Player ${playerName} created room ${roomId} as ${room.players[0].gamePlayerId}`);
  
  res.json({
    id: roomId,
    host: playerName,
    status: 'waiting',
    playerId: playerId // Return player ID for socket tracking
  });
});

app.post('/api/rooms/:roomId/join', (req, res) => {
  const { roomId } = req.params;
  const { playerName } = req.body;

  if (!playerName) {
    return res.status(400).json({ error: 'Player name is required' });
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== 'waiting') {
    return res.status(400).json({ error: 'Room is not available' });
  }

  if (room.players.length >= 2) {
    return res.status(400).json({ error: 'Room is full' });
  }

  // Check if player name already exists in the room
  const existingPlayer = room.players.find(p => p.name === playerName);
  if (existingPlayer) {
    return res.status(400).json({ error: 'A player with this name already exists in the room' });
  }

  const playerId = generateUserId();
  const newPlayer = { id: playerId, name: playerName, isHost: false, gamePlayerId: 'player2' };
  room.players.push(newPlayer);

  console.log(`API JOIN: Player ${playerName} joined room ${roomId} as ${newPlayer.gamePlayerId}`);
  console.log(`Room ${roomId} now has ${room.players.length} players:`);
  room.players.forEach(player => {
    console.log(`  - ${player.name} (${player.gamePlayerId}) - Host: ${player.isHost}`);
  });

  // Notify all players in the room about the new player
  io.to(roomId).emit('playerJoined', { player: newPlayer, room });

  res.json({ 
    success: true, 
    room,
    playerId: playerId // Return player ID for socket tracking
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('joinRoom', (data) => {
    const { roomId, playerId, playerName } = data;
    socket.join(roomId);
    
    // Track this socket's player info
    socketToPlayer.set(socket.id, { roomId, playerId, playerName });
    
    console.log(`SOCKET JOIN: Socket ${socket.id} joined room ${roomId} as ${playerName} (playerId: ${playerId})`);
    
    // Send room state to the joining player
    const room = rooms.get(roomId);
    if (room) {
      console.log(`Room ${roomId} current state:`);
      room.players.forEach(player => {
        console.log(`  - ${player.name} (${player.gamePlayerId}) - ID: ${player.id} - Host: ${player.isHost}`);
      });
      
      socket.emit('roomJoined', { room });
      console.log(`Sent roomJoined event to ${playerName} for room ${roomId}`);
    }
  });

  socket.on('leaveRoom', (data) => {
    console.log(`leaveRoom event received with data:`, data);
    console.log(`Socket ${socket.id} leaveRoom data type:`, typeof data);
    
    // Handle both old format (just roomId) and new format (object)
    let roomId, playerId, playerName;
    
    if (typeof data === 'string') {
      // Old format: just roomId string
      roomId = data;
      const playerInfo = socketToPlayer.get(socket.id);
      console.log(`Old format - playerInfo from socketToPlayer:`, playerInfo);
      if (playerInfo) {
        playerId = playerInfo.playerId;
        playerName = playerInfo.playerName;
      }
    } else {
      // New format: { roomId, playerId, playerName }
      ({ roomId, playerId, playerName } = data);
      console.log(`New format - extracted:`, { roomId, playerId, playerName });
    }
    
    console.log(`Final values: roomId=${roomId}, playerId=${playerId}, playerName=${playerName}`);
    
    if (roomId && playerId) {
      console.log(`Received leaveRoom event from ${playerName} for room ${roomId}`);
      
      // Remove player from room
      const room = rooms.get(roomId);
      if (room) {
        console.log(`Room found:`, room);
        const playerIndex = room.players.findIndex(p => p.id === playerId);
        console.log(`Player index in room:`, playerIndex);
        if (playerIndex !== -1) {
          const removedPlayer = room.players.splice(playerIndex, 1)[0];
          console.log(`Removed player ${removedPlayer.name} from room ${roomId} (manual leave)`);
          
          // Notify other players in the room
          socket.to(roomId).emit('playerLeft', { 
            playerId, 
            playerName: removedPlayer.name, 
            remainingPlayers: room.players.length 
          });

          // Handle host transfer if the host left
          if (removedPlayer.isHost && room.players.length > 0) {
            const newHost = room.players[0];
            newHost.isHost = true;
            newHost.gamePlayerId = 'player1'; // New host becomes player1
            room.host = newHost.name;
            console.log(`Transferred host to ${newHost.name} in room ${roomId}`);
            
            // Notify players about new host
            io.to(roomId).emit('hostChanged', { 
              newHostId: newHost.id, 
              newHostName: newHost.name 
            });
          }

          // Delete room if it's empty
          if (room.players.length === 0) {
            rooms.delete(roomId);
            console.log(`Deleted empty room ${roomId}`);
          } else {
            // Update room status if needed
            if (room.status === 'playing' && room.players.length < 2) {
              room.status = 'waiting';
              console.log(`Room ${roomId} status changed to waiting (not enough players)`);
            }
          }
        } else {
          console.log(`Player ${playerName} not found in room ${roomId}`);
        }
      } else {
        console.log(`Room ${roomId} not found for leaving player ${playerName}`);
      }
    } else {
      console.log(`Missing roomId or playerId - roomId: ${roomId}, playerId: ${playerId}`);
    }
    
    socket.leave(roomId);
    socketToPlayer.delete(socket.id);
    console.log(`Socket ${socket.id} left room ${roomId}`);
  });

  socket.on('gameAction', (data) => {
    const { roomId, action, playerId } = data;
    // Relay game actions to other players in the room
    socket.to(roomId).emit('gameAction', { action, playerId });
  });

  socket.on('playerSubmitted', (data) => {
    const { roomId, playerId, playerName, gamePlayerId } = data;
    
    console.log(`Player ${playerName} (${gamePlayerId}) submitted in room ${roomId} from socket ${socket.id}`);
    
    // Get the room to check player count
    const room = rooms.get(roomId);
    if (room) {
      console.log(`Room ${roomId} has ${room.players.length} players`);
      console.log(`Relaying playerSubmitted event to other players in room ${roomId}`);
      
      // Log all players in the room for debugging
      room.players.forEach(player => {
        console.log(`  - Player: ${player.name} (${player.gamePlayerId})`);
      });
      
      // Track submissions in the room
      if (!room.submissions) {
        room.submissions = new Set();
      }
      
      room.submissions.add(gamePlayerId);
      console.log(`Submissions tracked for room ${roomId}:`, Array.from(room.submissions));
      
      // Check if both players have submitted
      if (room.submissions.size === 2) {
        console.log(`Both players have submitted in room ${roomId}! Triggering replay phase...`);
        
        // Emit replay phase event to all players in the room
        io.to(roomId).emit('replayPhase', {
          roomId,
          message: 'Both players have submitted! Starting replay phase...'
        });
        
        // Reset submissions for next round
        room.submissions.clear();
        console.log(`Reset submissions tracking for room ${roomId}`);
      }
    } else {
      console.log(`Room ${roomId} not found for playerSubmitted event`);
    }
    
    // Relay the submission event to all other players in the room (excluding the sender)
    socket.to(roomId).emit('playerSubmitted', data);
  });

  socket.on('gameState', (data) => {
    const { roomId, playerId, playerName, gamePlayerId, echoes } = data;
    
    console.log(`=== GAME STATE EVENT RECEIVED ===`);
    console.log(`Full data received:`, JSON.stringify(data, null, 2));
    console.log(`Player ${playerName} (${gamePlayerId}) sending game state in room ${roomId} from socket ${socket.id}`);
    console.log(`Echoes count: ${echoes ? echoes.length : 0}`);
    console.log(`Echoes data:`, echoes);
    console.log(`================================`);
    
    // Get the room to verify it exists
    const room = rooms.get(roomId);
    if (room) {
      console.log(`Relaying gameState as opponentEchoes to other players in room ${roomId}`);
      
      // Relay the game state to the other player as opponentEchoes
      socket.to(roomId).emit('opponentEchoes', {
        roomId,
        playerId,
        playerName,
        gamePlayerId,
        echoes
      });
    } else {
      console.log(`Room ${roomId} not found for gameState event`);
    }
  });

  socket.on('chatMessage', (data) => {
    const { roomId, message, playerName } = data;
    // Relay chat messages to all players in the room
    io.to(roomId).emit('chatMessage', { message, playerName, timestamp: new Date() });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Get player info for this socket
    const playerInfo = socketToPlayer.get(socket.id);
    if (!playerInfo) {
      console.log('No player info found for disconnected socket');
      return;
    }

    const { roomId, playerId, playerName } = playerInfo;
    const room = rooms.get(roomId);
    
    if (!room) {
      console.log(`Room ${roomId} not found for disconnected player`);
      socketToPlayer.delete(socket.id);
      return;
    }

    // Remove player from room
    const playerIndex = room.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) {
      const removedPlayer = room.players.splice(playerIndex, 1)[0];
      console.log(`Removed player ${playerName} from room ${roomId}`);
      
      // Notify other players in the room
      socket.to(roomId).emit('playerLeft', { 
        playerId, 
        playerName, 
        remainingPlayers: room.players.length 
      });

      // Handle host transfer if the host left
      if (removedPlayer.isHost && room.players.length > 0) {
        const newHost = room.players[0];
        newHost.isHost = true;
        newHost.gamePlayerId = 'player1'; // New host becomes player1
        room.host = newHost.name;
        console.log(`Transferred host to ${newHost.name} in room ${roomId}`);
        
        // Notify players about new host
        io.to(roomId).emit('hostChanged', { 
          newHostId: newHost.id, 
          newHostName: newHost.name 
        });
      }

      // Delete room if it's empty
      if (room.players.length === 0) {
        rooms.delete(roomId);
        console.log(`Deleted empty room ${roomId}`);
      } else {
        // Update room status if needed
        if (room.status === 'playing' && room.players.length < 2) {
          room.status = 'waiting';
          console.log(`Room ${roomId} status changed to waiting (not enough players)`);
        }
      }
    }

    // Clean up socket tracking
    socketToPlayer.delete(socket.id);
  });
});

// Utility functions
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateUserId() {
  return Math.random().toString(36).substring(2, 15);
}

// Helper function to get room info for debugging
function getRoomInfo(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  
  return {
    id: room.id,
    host: room.host,
    status: room.status,
    playerCount: room.players.length,
    players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, gamePlayerId: p.gamePlayerId })),
    createdAt: room.createdAt
  };
}

// Debug endpoint to see all rooms (remove in production)
app.get('/api/debug/rooms', (req, res) => {
  const allRooms = Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId));
  console.log(`DEBUG: Total rooms in memory: ${rooms.size}`);
  allRooms.forEach(room => {
    if (room) {
      console.log(`  - Room ${room.id}: ${room.playerCount}/2 players, status: ${room.status}, host: ${room.host}`);
      room.players.forEach(player => {
        console.log(`    * ${player.name} (${player.gamePlayerId}) - Host: ${player.isHost}`);
      });
      
      // Show submission status if available
      const actualRoom = rooms.get(room.id);
      if (actualRoom && actualRoom.submissions) {
        console.log(`    * Submissions: ${Array.from(actualRoom.submissions).join(', ')}`);
      }
    }
  });
  res.json({
    totalRooms: rooms.size,
    rooms: allRooms.map(room => {
      if (room) {
        const actualRoom = rooms.get(room.id);
        return {
          ...room,
          submissions: actualRoom && actualRoom.submissions ? Array.from(actualRoom.submissions) : []
        };
      }
      return room;
    }),
    activeSockets: socketToPlayer.size
  });
});

// Debug endpoint to check submission status for a specific room
app.get('/api/debug/rooms/:roomId/submissions', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    roomId,
    submissions: room.submissions ? Array.from(room.submissions) : [],
    submissionCount: room.submissions ? room.submissions.size : 0,
    playerCount: room.players.length,
    players: room.players.map(p => ({ name: p.name, gamePlayerId: p.gamePlayerId }))
  });
});

// Manual trigger for replay phase (for testing)
app.post('/api/debug/rooms/:roomId/trigger-replay', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  console.log(`Manually triggering replay phase for room ${roomId}`);
  
  // Emit replay phase event to all players in the room
  io.to(roomId).emit('replayPhase', {
    roomId,
    message: 'Replay phase manually triggered for testing!'
  });
  
  // Reset submissions
  if (room.submissions) {
    room.submissions.clear();
  }
  
  res.json({ 
    success: true, 
    message: 'Replay phase triggered',
    roomId 
  });
});

// Reset submissions for a room (for testing)
app.post('/api/debug/rooms/:roomId/reset-submissions', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  if (room.submissions) {
    room.submissions.clear();
    console.log(`Reset submissions for room ${roomId}`);
  }
  
  res.json({ 
    success: true, 
    message: 'Submissions reset',
    roomId 
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Echoes backend server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
  console.log(`🌐 CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
}); 