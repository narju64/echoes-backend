const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
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

  const roomId = generateRoomId();
  const playerId = generateUserId();
  const room = {
    id: roomId,
    host: playerName,
    status: 'waiting',
    players: [{ id: playerId, name: playerName, isHost: true }],
    createdAt: new Date(),
    gameState: null
  };

  rooms.set(roomId, room);
  
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

  const playerId = generateUserId();
  const newPlayer = { id: playerId, name: playerName, isHost: false };
  room.players.push(newPlayer);

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
    
    console.log(`Socket ${socket.id} joined room ${roomId} as ${playerName}`);
    
    // Send room state to the joining player
    const room = rooms.get(roomId);
    if (room) {
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
    players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
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
    }
  });
  res.json({
    totalRooms: rooms.size,
    rooms: allRooms,
    activeSockets: socketToPlayer.size
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Echoes backend server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
  console.log(`🌐 CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
}); 