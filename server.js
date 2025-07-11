const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://localhost:8080',
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
      console.log(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  credentials: true,
  optionsSuccessStatus: 200
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

// Track disconnect timers for players
const disconnectTimers = new Map();

// Basic health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Echoes backend is running' });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Echoes Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      rooms: '/api/rooms',
      matches: '/api/matches'
    }
  });
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

// Match logging API
app.post('/api/matches', async (req, res) => {
  try {
    const matchData = req.body;
    
    // Validate required fields
    if (!matchData.matchId) {
      return res.status(400).json({ error: 'matchId is required' });
    }
    
    if (!matchData.startTime || !matchData.endTime) {
      return res.status(400).json({ error: 'startTime and endTime are required' });
    }
    
    if (!matchData.players || !Array.isArray(matchData.players) || matchData.players.length === 0) {
      return res.status(400).json({ error: 'players array is required and must not be empty' });
    }
    
    if (!matchData.events || !Array.isArray(matchData.events)) {
      return res.status(400).json({ error: 'events array is required' });
    }
    
    // Validate timestamps
    if (typeof matchData.startTime !== 'number' || typeof matchData.endTime !== 'number') {
      return res.status(400).json({ error: 'startTime and endTime must be numbers' });
    }
    
    if (matchData.startTime >= matchData.endTime) {
      return res.status(400).json({ error: 'startTime must be before endTime' });
    }
    
    // Create matches directory if it doesn't exist
    const matchesDir = path.join(__dirname, 'matches');
    try {
      await fs.access(matchesDir);
    } catch (error) {
      await fs.mkdir(matchesDir, { recursive: true });
      console.log(`Created matches directory: ${matchesDir}`);
    }
    
    // Create filename from matchId
    const filename = `${matchData.matchId}.json`;
    const filepath = path.join(matchesDir, filename);
    
    // Check if file already exists (shouldn't happen with unique matchIds)
    try {
      await fs.access(filepath);
      console.log(`Warning: Match file already exists: ${filename}`);
    } catch (error) {
      // File doesn't exist, which is expected
    }
    
    // Add server timestamp for when the match was logged
    const matchDataWithTimestamp = {
      ...matchData,
      loggedAt: Date.now(),
      serverVersion: '1.0.0' // For future compatibility
    };
    
    // Write match data to file
    await fs.writeFile(filepath, JSON.stringify(matchDataWithTimestamp, null, 2));
    
    console.log(`✅ Match logged successfully: ${filename}`);
    console.log(`   - Duration: ${matchData.duration || 'N/A'}ms`);
    console.log(`   - Players: ${matchData.players.join(', ')}`);
    console.log(`   - Events: ${matchData.events.length}`);
    console.log(`   - Winner: ${matchData.winner || 'N/A'}`);
    
    res.json({
      success: true,
      matchId: matchData.matchId,
      message: 'Match logged successfully',
      filepath: filename
    });
    
  } catch (error) {
    console.error('❌ Error logging match:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to log match',
      message: error.message
    });
  }
});

// Download all matches as individual files
app.get('/api/matches/download', async (req, res) => {
  try {
    const matchesDir = path.join(__dirname, 'matches');
    
    try {
      await fs.access(matchesDir);
    } catch (error) {
      return res.status(404).json({ error: 'No matches directory found' });
    }
    
    const files = await fs.readdir(matchesDir);
    const matchFiles = files.filter(file => file.endsWith('.json'));
    
    if (matchFiles.length === 0) {
      return res.status(404).json({ error: 'No match files found' });
    }
    
    // Create a simple text file with all match data
    let allMatchesData = `Echoes Match Data Export\nGenerated: ${new Date().toISOString()}\nTotal Matches: ${matchFiles.length}\n\n`;
    
    for (const file of matchFiles) {
      try {
        const filepath = path.join(matchesDir, file);
        const matchData = await fs.readFile(filepath, 'utf8');
        const parsedData = JSON.parse(matchData);
        
        allMatchesData += `=== ${file} ===\n`;
        allMatchesData += `Match ID: ${parsedData.matchId}\n`;
        allMatchesData += `Start Time: ${new Date(parsedData.startTime).toISOString()}\n`;
        allMatchesData += `Duration: ${parsedData.duration}ms\n`;
        allMatchesData += `Players: ${parsedData.players.join(', ')}\n`;
        allMatchesData += `Winner: ${parsedData.winner || 'N/A'}\n`;
        allMatchesData += `Events: ${parsedData.events ? parsedData.events.length : 0}\n\n`;
      } catch (error) {
        console.error(`Error reading match file ${file}:`, error);
        allMatchesData += `=== ${file} ===\nError reading file\n\n`;
      }
    }
    
    // Set headers for file download
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="echoes-matches-summary-${Date.now()}.txt"`);
    
    // Send the data
    res.send(allMatchesData);
    
    console.log(`📦 Downloaded summary of ${matchFiles.length} match files`);
    
  } catch (error) {
    console.error('❌ Error creating match download:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create match download',
      message: error.message
    });
  }
});

// Get match data by matchId
app.get('/api/matches/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    
    if (!matchId) {
      return res.status(400).json({ error: 'matchId is required' });
    }
    
    const matchesDir = path.join(__dirname, 'matches');
    const filepath = path.join(matchesDir, `${matchId}.json`);
    
    try {
      const matchData = await fs.readFile(filepath, 'utf8');
      const parsedData = JSON.parse(matchData);
      
      res.json({
        success: true,
        match: parsedData
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Match not found' });
      }
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error retrieving match:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve match',
      message: error.message
    });
  }
});

// Get list of all matches (for debugging/analysis)
app.get('/api/matches', async (req, res) => {
  try {
    const matchesDir = path.join(__dirname, 'matches');
    
    try {
      await fs.access(matchesDir);
    } catch (error) {
      // Matches directory doesn't exist yet, return empty list
      return res.json({
        success: true,
        matches: [],
        total: 0
      });
    }
    
    const files = await fs.readdir(matchesDir);
    const matchFiles = files.filter(file => file.endsWith('.json'));
    
    const matches = [];
    for (const file of matchFiles) {
      try {
        const filepath = path.join(matchesDir, file);
        const matchData = await fs.readFile(filepath, 'utf8');
        const parsedData = JSON.parse(matchData);
        
        // Return summary data only
        matches.push({
          matchId: parsedData.matchId,
          startTime: parsedData.startTime,
          endTime: parsedData.endTime,
          duration: parsedData.duration,
          players: parsedData.players,
          gameMode: parsedData.gameMode,
          winner: parsedData.winner,
          winCondition: parsedData.winCondition,
          eventCount: parsedData.events ? parsedData.events.length : 0,
          turnCount: parsedData.finalState?.turnNumber || 0,
          loggedAt: parsedData.loggedAt
        });
      } catch (error) {
        console.error(`Error reading match file ${file}:`, error);
        // Continue with other files
      }
    }
    
    // Sort by start time (newest first)
    matches.sort((a, b) => b.startTime - a.startTime);
    
    res.json({
      success: true,
      matches,
      total: matches.length
    });
    
  } catch (error) {
    console.error('❌ Error retrieving matches list:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve matches list',
      message: error.message
    });
  }
});

// Clear all matches
app.delete('/api/matches', async (req, res) => {
  // Only allow in development mode, localhost requests, or with admin key
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isLocalhost = req.headers.origin && (
    req.headers.origin.includes('localhost') || 
    req.headers.origin.includes('127.0.0.1')
  );
  const adminKey = req.headers['x-admin-key'];
  const expectedAdminKey = process.env.ADMIN_KEY;
  
  // Debug logging
  console.log('🔐 DELETE /api/matches - Auth check:');
  console.log(`  - NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`  - isDevelopment: ${isDevelopment}`);
  console.log(`  - isLocalhost: ${isLocalhost}`);
  console.log(`  - origin: ${req.headers.origin}`);
  console.log(`  - adminKey provided: ${adminKey ? 'YES' : 'NO'}`);
  console.log(`  - expectedAdminKey set: ${expectedAdminKey ? 'YES' : 'NO'}`);
  console.log(`  - adminKey matches: ${adminKey === expectedAdminKey}`);
  console.log(`  - All env vars:`, Object.keys(process.env).filter(key => key.includes('ADMIN') || key.includes('NODE')));
  console.log(`  - ADMIN_KEY value: "${process.env.ADMIN_KEY}"`);
  
  if (!isDevelopment && !isLocalhost && (!adminKey || adminKey !== expectedAdminKey)) {
    console.log('❌ Access denied - missing or invalid admin key');
    return res.status(403).json({
      success: false,
      error: 'Access denied. This endpoint is only available in development mode or with proper authorization.'
    });
  }
  
  console.log('✅ Access granted - proceeding with match deletion');
  
  try {
    const matchesDir = path.join(__dirname, 'matches');
    
    try {
      await fs.access(matchesDir);
    } catch (error) {
      // Matches directory doesn't exist, return success
      return res.json({
        success: true,
        message: 'No matches directory found - nothing to clear',
        deletedCount: 0
      });
    }
    
    const files = await fs.readdir(matchesDir);
    const matchFiles = files.filter(file => file.endsWith('.json'));
    
    if (matchFiles.length === 0) {
      return res.json({
        success: true,
        message: 'No match files found to clear',
        deletedCount: 0
      });
    }
    
    let deletedCount = 0;
    for (const file of matchFiles) {
      try {
        const filepath = path.join(matchesDir, file);
        await fs.unlink(filepath);
        deletedCount++;
        console.log(`🗑️ Deleted match file: ${file}`);
      } catch (error) {
        console.error(`Error deleting match file ${file}:`, error);
        // Continue with other files
      }
    }
    
    console.log(`🗑️ Cleared ${deletedCount} match files`);
    
    res.json({
      success: true,
      message: `Successfully cleared ${deletedCount} match files`,
      deletedCount
    });
    
  } catch (error) {
    console.error('❌ Error clearing matches:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear matches',
      message: error.message
    });
  }
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
    
    // If player is reconnecting within grace period, cancel timer
    if (disconnectTimers.has(playerId)) {
      clearTimeout(disconnectTimers.get(playerId));
      disconnectTimers.delete(playerId);
      // Notify other player of reconnection
      socket.to(roomId).emit('opponentReconnected', { playerId, playerName });
      console.log(`Player ${playerName} (playerId: ${playerId}) reconnected to room ${roomId}`);
    }

    // Send room state to the joining player
    const room = rooms.get(roomId);
    if (room) {
      console.log(`Room ${roomId} current state:`);
      room.players.forEach(player => {
        console.log(`  - ${player.name} (${player.gamePlayerId}) - ID: ${player.id} - Host: ${player.isHost}`);
      });
      
      socket.emit('roomJoined', { room });
      // Send latest game state if available
      if (room.gameState) {
        socket.emit('gameState', room.gameState);
      }
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

    // Notify other player of disconnect
    socket.to(roomId).emit('opponentDisconnected', { playerId, playerName });
    // Start a 30s timer before removing the player
    const timer = setTimeout(() => {
      // Remove player from room and clean up (existing logic)
      const playerIndex = room.players.findIndex(p => p.id === playerId);
      if (playerIndex !== -1) {
        const removedPlayer = room.players.splice(playerIndex, 1)[0];
        console.log(`Removed player ${removedPlayer.name} from room ${roomId} (after grace period)`);
        socket.to(roomId).emit('playerLeft', {
          playerId,
          playerName: removedPlayer.name,
          remainingPlayers: room.players.length
        });
        if (removedPlayer.isHost && room.players.length > 0) {
          const newHost = room.players[0];
          newHost.isHost = true;
          newHost.gamePlayerId = 'player1';
          room.host = newHost.name;
          io.to(roomId).emit('hostChanged', {
            newHostId: newHost.id,
            newHostName: newHost.name
          });
        }
        if (room.players.length === 0) {
          rooms.delete(roomId);
          console.log(`Deleted empty room ${roomId}`);
        } else {
          if (room.status === 'playing' && room.players.length < 2) {
            room.status = 'waiting';
            console.log(`Room ${roomId} status changed to waiting (not enough players)`);
          }
        }
      }
      disconnectTimers.delete(playerId);
    }, 30000); // 30 seconds
    disconnectTimers.set(playerId, timer);
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

// Global error handler to ensure JSON responses
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler for unmatched routes
app.use((req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    error: 'Route not found',
    message: `No route found for ${req.method} ${req.originalUrl}`
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Echoes backend server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
  console.log(`🌐 CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`📋 Allowed origins: ${allowedOrigins.join(', ')}`);
}); 