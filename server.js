const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
  });
}

// Create a socket.io instance with CORS configuration
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Store room data
const rooms = {};
const userSocketMap = {};
const peerIdMap = {};

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  // Join room
  socket.on('joinRoom', (data) => {
    const { roomId, username, isHost } = data;
    
    console.log(`User ${username} joining room ${roomId} (isHost: ${isHost})`);
    
    // Create room if it doesn't exist
    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        users: [],
        host: isHost ? socket.id : null,
        streaming: false,
        fileName: null,
        fileType: null
      };
    }
    
    // If this socket already has a user in this room, update it
    const existingUserIndex = rooms[roomId].users.findIndex(user => user.id === socket.id);
    
    if (existingUserIndex !== -1) {
      rooms[roomId].users[existingUserIndex] = {
        id: socket.id,
        username,
        isHost
      };
    } else {
      // Add user to room
      rooms[roomId].users.push({
        id: socket.id,
        username,
        isHost
      });
    }
    
    // Update host if needed
    if (isHost) {
      rooms[roomId].host = socket.id;
    }
    
    // Map socket ID to room ID for disconnection handling
    userSocketMap[socket.id] = roomId;
    
    // Join socket room
    socket.join(roomId);
    
    // Notify all users in room about the new user
    io.to(roomId).emit('userJoined', {
      user: {
        id: socket.id,
        username,
        isHost
      },
      users: rooms[roomId].users
    });
    
    // Send current streaming status to new user
    socket.emit('streaming-status', {
      isStreaming: rooms[roomId].streaming,
      fileName: rooms[roomId].fileName,
      fileType: rooms[roomId].fileType
    });
    
    console.log(`Room ${roomId} now has ${rooms[roomId].users.length} users`);
  });
  
  // Register peer ID
  socket.on('peer-id', (data) => {
    const { roomId, peerId, isHost, socketId } = data;
    
    console.log(`Peer ID registered for ${socketId || socket.id}: ${peerId} (isHost: ${isHost})`);
    
    // Store peer ID mapping
    peerIdMap[socketId || socket.id] = peerId;
    
    // Notify all users in room about the peer ID
    io.to(roomId).emit('peer-id', {
      socketId: socketId || socket.id,
      peerId,
      isHost
    });
  });
  
  // Handle chat messages
  socket.on('sendMessage', (data) => {
    const { roomId, message, username } = data;
    
    console.log(`Chat message in room ${roomId} from ${username}: ${message}`);
    
    // Send message to all users in room
    io.to(roomId).emit('newMessage', {
      user: username,
      text: message,
      time: new Date().toLocaleTimeString()
    });
  });
  
  // Handle streaming status updates
  socket.on('streaming-status-update', (data) => {
    const { roomId, streaming, fileName, fileType } = data;
    
    console.log(`Streaming status update for room ${roomId}: ${streaming}`);
    
    if (rooms[roomId]) {
      rooms[roomId].streaming = streaming;
      rooms[roomId].fileName = fileName;
      rooms[roomId].fileType = fileType;
      
      // Notify all users in room about the streaming status
      io.to(roomId).emit('streaming-status', {
        isStreaming: streaming,
        fileName,
        fileType
      });
    }
  });
  
  // Handle video state changes (play/pause/seek)
  socket.on('videoStateChange', (data) => {
    const { roomId, videoState } = data;
    
    console.log(`Video state change in room ${roomId}:`, videoState);
    
    // Forward video state change to all users in room except sender
    socket.to(roomId).emit('videoStateUpdate', videoState);
  });
  
  // Handle "about to start streaming" notification
  socket.on('streamingAboutToStart', (data) => {
    const { roomId } = data;
    
    console.log(`Host is about to start streaming in room ${roomId}`);
    
    // Notify viewers that host is about to start streaming
    socket.to(roomId).emit('streamingAboutToStart');
  });
  
  // Handle WebRTC signaling
  socket.on('signal', (data) => {
    const { to, from, signal, type } = data;
    
    console.log(`Signal from ${from} to ${to} (${type})`);
    
    // Forward signal to recipient
    io.to(to).emit('signal', {
      from,
      signal,
      type
    });
  });
  
  // Handle ICE candidate exchange
  socket.on('ice-candidate', (data) => {
    const { to, candidate } = data;
    
    console.log(`ICE candidate from ${socket.id} to ${to}`);
    
    // Forward ICE candidate to recipient
    io.to(to).emit('ice-candidate', {
      from: socket.id,
      candidate
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // Get room ID this socket was in
    const roomId = userSocketMap[socket.id];
    
    if (roomId && rooms[roomId]) {
      // Get username before removing from room
      const user = rooms[roomId].users.find(u => u.id === socket.id);
      const username = user ? user.username : 'Unknown user';
      
      // Remove user from room
      rooms[roomId].users = rooms[roomId].users.filter(user => user.id !== socket.id);
      
      // If room is empty, remove it
      if (rooms[roomId].users.length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (empty)`);
      } else {
        // If host left, assign new host if possible
        if (rooms[roomId].host === socket.id) {
          rooms[roomId].host = null;
          rooms[roomId].streaming = false;
          
          // Notify all users that streaming has stopped
          io.to(roomId).emit('streaming-status', {
            isStreaming: false,
            fileName: null,
            fileType: null
          });
          
          console.log(`Host left room ${roomId}, streaming stopped`);
        }
        
        // Notify remaining users that this user left
        io.to(roomId).emit('userLeft', {
          username,
          users: rooms[roomId].users
        });
        
        console.log(`User ${username} left room ${roomId}`);
      }
    }
    
    // Clean up mapping
    delete userSocketMap[socket.id];
    delete peerIdMap[socket.id];
  });
  
  // Handle room creation
  socket.on('create-room', (_, callback) => {
    // Generate a random room ID
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let roomId = '';
    
    // Ensure unique room ID
    do {
      roomId = '';
      for (let i = 0; i < 6; i++) {
        roomId += characters.charAt(Math.floor(Math.random() * characters.length));
      }
    } while (rooms[roomId]);
    
    console.log(`Created new room: ${roomId}`);
    
    if (callback && typeof callback === 'function') {
      callback({ roomId });
    } else {
      socket.emit('roomCreated', { roomId });
    }
  });
});

// Create room endpoint
app.post('/create-room', (req, res) => {
  // Generate a random room ID
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let roomId = '';
  
  // Ensure unique room ID
  do {
    roomId = '';
    for (let i = 0; i < 6; i++) {
      roomId += characters.charAt(Math.floor(Math.random() * characters.length));
    }
  } while (rooms[roomId]);
  
  console.log(`API created new room: ${roomId}`);
  
  res.json({ roomId });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});