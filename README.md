# Echoes Backend

A real-time multiplayer backend for the Echoes game, built with Express.js and Socket.IO.

## Features

- Real-time multiplayer game rooms
- WebSocket communication for game state synchronization
- Match logging system for game analysis
- CORS support for cross-origin requests

## API Endpoints

### Match Logging

#### `POST /api/matches`
Log a completed match with all game events and data.

**Request Body:**
```json
{
  "matchId": "match_1703123456789_abc123def",
  "startTime": 1703123456789,
  "endTime": 1703123567890,
  "gameMode": "hotseat",
  "players": ["player1", "player2"],
  "events": [
    {
      "timestamp": 1703123456789,
      "type": "match_start",
      "data": { /* game initialization data */ }
    },
    {
      "timestamp": 1703123457000,
      "type": "action",
      "data": {
        "player": "player1",
        "echoId": "echo_123",
        "action": "walk",
        "position": {"row": 3, "col": 4},
        "direction": {"x": 0, "y": 1},
        "cost": 1
      }
    }
    // ... more events
  ],
  "initialState": { /* complete initial game state */ },
  "finalState": { /* complete final game state */ },
  "winner": "player2",
  "winCondition": "10_points",
  "finalScore": {"player1": 3, "player2": 10},
  "duration": 110101
}
```

**Response:**
```json
{
  "success": true,
  "matchId": "match_1703123456789_abc123def",
  "message": "Match logged successfully",
  "filepath": "match_1703123456789_abc123def.json"
}
```

#### `GET /api/matches`
Get a list of all logged matches (summary data only).

**Response:**
```json
{
  "success": true,
  "matches": [
    {
      "matchId": "match_1703123456789_abc123def",
      "startTime": 1703123456789,
      "endTime": 1703123567890,
      "duration": 110101,
      "players": ["player1", "player2"],
      "winner": "player2",
      "winCondition": "10_points",
      "eventCount": 5,
      "loggedAt": 1703123568000
    }
  ],
  "total": 1
}
```

#### `GET /api/matches/:matchId`
Get complete match data by match ID.

**Response:**
```json
{
  "success": true,
  "match": {
    // Complete match data including all events
  }
}
```

### Room Management

#### `GET /api/rooms`
Get list of available rooms.

#### `POST /api/rooms`
Create a new room.

#### `POST /api/rooms/:roomId/join`
Join an existing room.

### Health Check

#### `GET /api/health`
Basic health check endpoint.

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your configuration:
```env
PORT=3000
FRONTEND_URL=http://localhost:5173
```

3. Start the server:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Testing

Run the match logging test:
```bash
node test-match-logging.js
```

## File Structure

```
echoes-backend/
├── server.js              # Main server file
├── package.json           # Dependencies and scripts
├── test-match-logging.js  # Test script for match logging
├── matches/               # Directory for stored match files
│   ├── match_*.json       # Individual match files
│   └── ...
└── README.md             # This file
```

## Match Storage

Matches are stored as individual JSON files in the `matches/` directory. Each file contains:

- Complete match data with all events
- Server timestamp when logged
- Server version for compatibility tracking
- All game states and player actions

## Event Types

The match logging system supports these event types:

- `match_start`: Game initialization
- `tick_start`: Beginning of a simulation tick
- `action`: Player action (walk, dash, fire, mine, shield)
- `collision`: Entity collision
- `entity_destroyed`: Entity destruction
- `tick_end`: End of a simulation tick
- `match_end`: Game completion

## Error Handling

The API returns appropriate HTTP status codes:

- `200`: Success
- `400`: Bad request (missing required fields, invalid data)
- `404`: Match not found
- `500`: Server error (file system issues, etc.)

All responses include a JSON body with success status and relevant information. 