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
  transports: ['websocket', 'polling'],
  pingTimeout: 60000, // Increase ping timeout
  pingInterval: 25000 // More frequent ping
});

// Store room data
const rooms = {};
const userSocketMap = {};
const peerIdMap = {};
// Track connection health data
const connectionHealth = {};

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  // Initialize connection health tracking
  connectionHealth[socket.id] = {
    lastHeartbeat: Date.now(),
    isConnected: true,
    isHost: false,
    roomId: null,
    username: null,
    connectionQuality: 'unknown',
    isChatOnly: false
  };
  
  // Join room
  socket.on('joinRoom', (data) => {
    const { roomId, username, isHost, isChatOnly } = data;
    
    console.log(`User ${username} joining room ${roomId} (isHost: ${isHost}, isChatOnly: ${isChatOnly || false})`);
    
    // Update connection health data
    connectionHealth[socket.id].roomId = roomId;
    connectionHealth[socket.id].username = username;
    connectionHealth[socket.id].isHost = isHost;
    connectionHealth[socket.id].isChatOnly = isChatOnly || false;
    
    // Create room if it doesn't exist
    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        users: [],
        host: isHost ? socket.id : null,
        streaming: false,
        fileName: null,
        fileType: null,
        lastActive: Date.now(),
        syncState: null // For backup state tracking
      };
    }
    
    // If this socket already has a user in this room, update it
    const existingUserIndex = rooms[roomId].users.findIndex(user => user.id === socket.id);
    
    if (existingUserIndex !== -1) {
      rooms[roomId].users[existingUserIndex] = {
        id: socket.id,
        username,
        isHost,
        isChatOnly: isChatOnly || false,
        lastActive: Date.now()
      };
    } else {
      // Add user to room
      rooms[roomId].users.push({
        id: socket.id,
        username,
        isHost,
        isChatOnly: isChatOnly || false,
        lastActive: Date.now()
      });
    }
    
    // Update host if needed
    if (isHost) {
      rooms[roomId].host = socket.id;
    }
    
    // Update room last active time
    rooms[roomId].lastActive = Date.now();
    
    // Map socket ID to room ID for disconnection handling
    userSocketMap[socket.id] = roomId;
    
    // Join socket room
    socket.join(roomId);
    
    // Notify all users in room about the new user
    io.to(roomId).emit('userJoined', {
      user: {
        id: socket.id,
        username,
        isHost,
        isChatOnly: isChatOnly || false
      },
      users: rooms[roomId].users
    });
    
    // Send current streaming status to new user (skip for chat-only users if preferred)
    socket.emit('streaming-status', {
      isStreaming: rooms[roomId].streaming,
      fileName: rooms[roomId].fileName,
      fileType: rooms[roomId].fileType
    });
    
    // If room has a recent sync state and this is a viewer, send it (skip for chat-only users)
    if (!isHost && !isChatOnly && rooms[roomId].syncState) {
      const syncState = rooms[roomId].syncState;
      // Only send if it's recent (last 2 minutes)
      if (Date.now() - syncState.timestamp < 120000) {
        socket.emit('fallback-sync-state', syncState);
      }
    }
    
    console.log(`Room ${roomId} now has ${rooms[roomId].users.length} users`);
  });
  
  // Improved heartbeat handler
  socket.on('heartbeat', (data) => {
    const { roomId, timestamp, isHost } = data;
    
    // Update connection health data
    if (connectionHealth[socket.id]) {
      connectionHealth[socket.id].lastHeartbeat = Date.now();
      connectionHealth[socket.id].roomId = roomId;
    }
    
    // Update room activity
    if (rooms[roomId]) {
      rooms[roomId].lastActive = Date.now();
      
      // Update user's last active timestamp
      const userIndex = rooms[roomId].users.findIndex(u => u.id === socket.id);
      if (userIndex !== -1) {
        rooms[roomId].users[userIndex].lastActive = Date.now();
      }
    }
    
    // Count active viewers
    let viewerCount = 0;
    let hostConnected = false;
    let chatOnlyCount = 0;
    
    if (rooms[roomId]) {
      viewerCount = rooms[roomId].users.filter(u => !u.isHost && !u.isChatOnly).length;
      chatOnlyCount = rooms[roomId].users.filter(u => u.isChatOnly).length;
      hostConnected = rooms[roomId].users.some(u => u.isHost && u.id !== socket.id);
    }
    
    // Send heartbeat acknowledgment with room stats
    socket.emit('heartbeat-ack', {
      timestamp: Date.now(),
      serverTime: Date.now(),
      clientTime: timestamp,
      viewerCount,
      chatOnlyCount,
      hostConnected
    });
  });
  
  // Register peer ID with improved tracking
  socket.on('peer-id', (data) => {
    const { roomId, peerId, isHost, previousSocketId } = data;
    
    console.log(`Peer ID registered: ${peerId} for socket ${socket.id} (previous: ${previousSocketId || 'N/A'})`);
    
    // Store peer ID mapping
    peerIdMap[socket.id] = peerId;
    
    // If this is a reconnection (previousSocketId provided), update mappings
    if (previousSocketId && peerIdMap[previousSocketId]) {
      // Remove the old mapping
      delete peerIdMap[previousSocketId];
      console.log(`Removed old peer ID mapping for ${previousSocketId}`);
    }
    
    // Notify all users in room about the peer ID
    io.to(roomId).emit('peer-id', {
      socketId: socket.id,
      peerId,
      isHost,
      isReconnection: !!previousSocketId
    });
  });
  
  // Enhanced video state change handler
  socket.on('videoStateChange', (data) => {
    const { roomId, videoState } = data;
    
    // Log detailed information
    console.log(`[${socket.id}] Sending ${videoState.isPlaying ? 'PLAY' : 'PAUSE'} at ${videoState.currentTime.toFixed(2)} to room ${roomId}`);
    
    if (rooms[roomId]) {
      // Store sync state for reconnection purposes
      rooms[roomId].syncState = {
        ...videoState,
        timestamp: Date.now(),
        hostId: socket.id
      };
    }
    
    // Forward to everyone in the room except the sender and chat-only users
    if (rooms[roomId]) {
      // Get non-chat-only users
      const regularViewers = rooms[roomId].users.filter(user => 
        user.id !== socket.id && !user.isChatOnly
      );
      
      // Emit to each regular viewer
      regularViewers.forEach(viewer => {
        io.to(viewer.id).emit('videoStateUpdate', {
          ...videoState,
          timestamp: Date.now()
        });
      });
    } else {
      // Fallback if room data is not available
      socket.to(roomId).emit('videoStateUpdate', {
        ...videoState,
        timestamp: Date.now()
      });
    }
  });
  
  // Enhanced seek operation handler
  socket.on('videoSeekOperation', (data) => {
    const { roomId, seekTime, isPlaying, sourceTimestamp } = data;
    
    console.log(`[${socket.id}] Sending SEEK to ${seekTime.toFixed(2)} in room ${roomId}`);
    
    // Calculate server processing latency
    const serverTimestamp = Date.now();
    const latency = sourceTimestamp ? serverTimestamp - sourceTimestamp : 0;
    
    // Store sync state for reconnection purposes
    if (rooms[roomId]) {
      rooms[roomId].syncState = {
        currentTime: seekTime,
        isPlaying: isPlaying !== undefined ? isPlaying : true,
        timestamp: serverTimestamp,
        hostId: socket.id,
        seekOperation: true
      };
      
      // Get non-chat-only users
      const regularViewers = rooms[roomId].users.filter(user => 
        user.id !== socket.id && !user.isChatOnly
      );
      
      // Emit to each regular viewer
      regularViewers.forEach(viewer => {
        io.to(viewer.id).emit('videoSeekOperation', {
          seekTime,
          isPlaying: isPlaying !== undefined ? isPlaying : true,
          sourceTimestamp,
          serverTimestamp,
          processingLatency: latency,
          hostId: socket.id
        });
      });
    } else {
      // Fallback if room data is not available
      socket.to(roomId).emit('videoSeekOperation', {
        seekTime,
        isPlaying: isPlaying !== undefined ? isPlaying : true,
        sourceTimestamp,
        serverTimestamp,
        processingLatency: latency,
        hostId: socket.id
      });
    }
  });
  
  // Fallback sync state handler
  socket.on('fallback-sync-state', (data) => {
    const { roomId, currentTime, isPlaying, timestamp, targetSocketId } = data;
    
    console.log(`[${socket.id}] Sending fallback sync state to ${targetSocketId || 'room'}: ${currentTime.toFixed(2)}, ${isPlaying ? 'playing' : 'paused'}`);
    
    // Store sync state for reconnection purposes
    if (rooms[roomId]) {
      rooms[roomId].syncState = {
        currentTime,
        isPlaying,
        timestamp: timestamp || Date.now(),
        hostId: socket.id
      };
    }
    
    // Send to specific target if provided
    if (targetSocketId) {
      // Check if target is not a chat-only user
      const targetUser = rooms[roomId]?.users.find(user => user.id === targetSocketId);
      if (targetUser && !targetUser.isChatOnly) {
        io.to(targetSocketId).emit('fallback-sync-state', {
          currentTime,
          isPlaying,
          timestamp: timestamp || Date.now(),
          hostId: socket.id
        });
      }
    } else {
      // Send to all non-chat-only users in room
      if (rooms[roomId]) {
        const regularViewers = rooms[roomId].users.filter(user => 
          user.id !== socket.id && !user.isChatOnly
        );
        
        regularViewers.forEach(viewer => {
          io.to(viewer.id).emit('fallback-sync-state', {
            currentTime,
            isPlaying,
            timestamp: timestamp || Date.now(),
            hostId: socket.id
          });
        });
      } else {
        // Fallback if room data is not available
        socket.to(roomId).emit('fallback-sync-state', {
          currentTime,
          isPlaying,
          timestamp: timestamp || Date.now(),
          hostId: socket.id
        });
      }
    }
  });
  
  // WebRTC connection failure handler
  socket.on('webrtc-connection-failed', (data) => {
    const { roomId, peerId } = data;
    
    console.log(`WebRTC connection failed in room ${roomId}: ${socket.id} to peer ${peerId}`);
    
    // Find socket ID for the peer ID
    const targetSocketId = Object.keys(peerIdMap).find(key => peerIdMap[key] === peerId);
    
    if (targetSocketId) {
      // Check if the target is not a chat-only user
      const targetUser = rooms[roomId]?.users.find(user => user.id === targetSocketId);
      if (targetUser && !targetUser.isChatOnly) {
        // Notify the target about connection failure
        io.to(targetSocketId).emit('webrtc-reconnect-requested', {
          fromSocketId: socket.id,
          fromPeerId: peerIdMap[socket.id]
        });
        
        console.log(`Sent reconnection request to ${targetSocketId}`);
      } else if (targetUser && targetUser.isChatOnly) {
        // If target is chat-only, notify sender that WebRTC is not needed
        socket.emit('webrtc-target-unreachable', {
          peerId,
          reason: 'Target is in chat-only mode and does not require video stream'
        });
      }
    } else {
      console.log(`Could not find socket ID for peer ${peerId}`);
      
      // Notify original socket that target may be disconnected
      socket.emit('webrtc-target-unreachable', {
        peerId,
        reason: 'Target peer ID not found in mappings'
      });
    }
  });
  
  // Viewer requesting reconnection handler
  socket.on('request-reconnection', (data) => {
    const { roomId, viewerPeerId } = data;
    
    console.log(`Viewer ${socket.id} requesting reconnection in room ${roomId}`);
    
    if (rooms[roomId] && rooms[roomId].host) {
      // Forward the request to the host
      io.to(rooms[roomId].host).emit('viewer-reconnection-request', {
        viewerSocketId: socket.id,
        viewerPeerId
      });
      
      console.log(`Forwarded reconnection request to host ${rooms[roomId].host}`);
    } else {
      // Notify viewer that host is not available
      socket.emit('reconnection-failed', {
        message: 'Host is not available for reconnection'
      });
    }
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
  
  // Enhanced streaming status update handler
  socket.on('streaming-status-update', (data) => {
    const { roomId, streaming, fileName, fileType } = data;
    
    console.log(`Streaming status update for room ${roomId}: ${streaming}`);
    
    if (rooms[roomId]) {
      rooms[roomId].streaming = streaming;
      rooms[roomId].fileName = fileName;
      rooms[roomId].fileType = fileType;
      
      // If streaming is stopping, clear sync state
      if (!streaming) {
        rooms[roomId].syncState = null;
      }
      
      // Notify non-chat-only users in room about the streaming status
      rooms[roomId].users.forEach(user => {
        if (!user.isChatOnly) {
          io.to(user.id).emit('streaming-status', {
            isStreaming: streaming,
            fileName,
            fileType
          });
        }
      });
    } else {
      // Fallback if room data is not available
      socket.to(roomId).emit('streaming-status', {
        isStreaming: streaming,
        fileName,
        fileType
      });
    }
  });
  
  // Handle "about to start streaming" notification
  socket.on('streamingAboutToStart', (data) => {
    const { roomId } = data;
    
    console.log(`Host is about to start streaming in room ${roomId}`);
    
    // Notify non-chat-only viewers that host is about to start streaming
    if (rooms[roomId]) {
      const regularViewers = rooms[roomId].users.filter(user => 
        user.id !== socket.id && !user.isChatOnly
      );
      
      regularViewers.forEach(viewer => {
        io.to(viewer.id).emit('streamingAboutToStart');
      });
    } else {
      // Fallback if room data is not available
      socket.to(roomId).emit('streamingAboutToStart');
    }
  });
  
  // Enhanced connection health check
  socket.on('connection-health-check', (data) => {
    const { roomId, targetSocketId } = data;
    
    console.log(`Connection health check from ${socket.id} to ${targetSocketId || 'all'} in room ${roomId}`);
    
    // If checking a specific user
    if (targetSocketId) {
      // Check if target is still connected
      const isConnected = io.sockets.sockets.has(targetSocketId);
      
      // Get connection health data
      const health = connectionHealth[targetSocketId] || { lastHeartbeat: 0 };
      const timeSinceHeartbeat = Date.now() - health.lastHeartbeat;
      const isChatOnly = health.isChatOnly || false;
      
      // Send health check response
      socket.emit('connection-health-response', {
        targetSocketId,
        isConnected,
        timeSinceHeartbeat,
        isChatOnly,
        timestamp: Date.now()
      });
      
      // Also notify the target that someone is checking their connection
      if (isConnected) {
        io.to(targetSocketId).emit('connection-being-checked', {
          fromSocketId: socket.id,
          timestamp: Date.now()
        });
      }
    } else {
      // Check all users in the room
      if (rooms[roomId]) {
        const healthStatus = {};
        
        // Get status for each user
        rooms[roomId].users.forEach(user => {
          const isConnected = io.sockets.sockets.has(user.id);
          const health = connectionHealth[user.id] || { lastHeartbeat: 0 };
          const timeSinceHeartbeat = Date.now() - health.lastHeartbeat;
          
          healthStatus[user.id] = {
            isConnected,
            timeSinceHeartbeat,
            isActive: timeSinceHeartbeat < 10000, // Consider active if heartbeat within 10s
            isChatOnly: user.isChatOnly || false
          };
        });
        
        // Send room health status
        socket.emit('room-health-status', {
          roomId,
          users: healthStatus,
          timestamp: Date.now()
        });
      }
    }
  });
  
  // Handle disconnection with improved cleanup
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // Get room ID this socket was in
    const roomId = userSocketMap[socket.id];
    
    if (roomId && rooms[roomId]) {
      // Get user info before removing
      const user = rooms[roomId].users.find(u => u.id === socket.id);
      const username = user ? user.username : 'Unknown user';
      const wasHost = user ? user.isHost : false;
      const wasChatOnly = user ? user.isChatOnly : false;
      
      console.log(`Disconnected user details: ${username}, isHost: ${wasHost}, isChatOnly: ${wasChatOnly}`);
      
      // Update connection health
      if (connectionHealth[socket.id]) {
        connectionHealth[socket.id].isConnected = false;
        connectionHealth[socket.id].disconnectedAt = Date.now();
      }
      
      // Don't immediately remove user - mark as inactive for potential reconnection
      if (user) {
        user.active = false;
        user.disconnectedAt = Date.now();
        
        // Schedule cleanup after 30 seconds if not reconnected
        setTimeout(() => {
          if (rooms[roomId] && rooms[roomId].users) {
            // Check if user is still in inactive state
            const currentUser = rooms[roomId].users.find(u => u.id === socket.id);
            if (currentUser && currentUser.active === false) {
              // Remove user after timeout
              rooms[roomId].users = rooms[roomId].users.filter(u => u.id !== socket.id);
              
              // If room is empty, remove it
              if (rooms[roomId].users.length === 0) {
                delete rooms[roomId];
                console.log(`Room ${roomId} deleted (empty)`);
              } else {
                // If host left and hasn't reconnected, update room state
                if (wasHost && rooms[roomId].host === socket.id) {
                  rooms[roomId].host = null;
                  rooms[roomId].streaming = false;
                  
                  // Notify all non-chat-only users that streaming has stopped
                  rooms[roomId].users.forEach(u => {
                    if (!u.isChatOnly) {
                      io.to(u.id).emit('streaming-status', {
                        isStreaming: false,
                        fileName: null,
                        fileType: null
                      });
                    }
                  });
                  
                  console.log(`Host left room ${roomId}, streaming stopped`);
                }
                
                // Notify remaining users that this user left
                io.to(roomId).emit('userLeft', {
                  username,
                  users: rooms[roomId].users.filter(u => u.active !== false)
                });
                
                console.log(`User ${username} removed from room ${roomId} after timeout`);
              }
            }
          }
          
          // Clean up connection health
          delete connectionHealth[socket.id];
        }, 30000); // 30 second grace period for reconnection
      }
      
      // Immediately notify other users that this user has disconnected
      // (but might reconnect)
      io.to(roomId).emit('userDisconnected', {
        userId: socket.id,
        username,
        isHost: wasHost,
        isChatOnly: wasChatOnly,
        timestamp: Date.now()
      });
    }
    
    // Don't immediately remove socket from maps to allow for reconnection
    // These will be cleaned up if the user doesn't reconnect
  });
  
  // Room creation with improved validation
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

// Periodic connection health check (run every 15 seconds)
setInterval(() => {
  const now = Date.now();
  
  // Check each room's health
  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId];
    
    // Skip recent rooms
    if (now - room.lastActive < 15000) return;
    
    // Check each user's connection health
    room.users.forEach(user => {
      // Skip already marked inactive users
      if (user.active === false) return;
      
      const health = connectionHealth[user.id];
      
      // If no health data or last heartbeat is too old (over 30 seconds)
      if (!health || now - health.lastHeartbeat > 30000) {
        console.log(`User ${user.username} (${user.id}) in room ${roomId} appears disconnected`);
        
        // Check if socket is actually connected
        const isConnected = io.sockets.sockets.has(user.id);
        
        if (!isConnected) {
          console.log(`Confirming ${user.id} is disconnected, marking as inactive`);
          // Mark as inactive
          user.active = false;
          user.disconnectedAt = now;
          
          // Notify room that user appears disconnected
          io.to(roomId).emit('userConnectionLost', {
            userId: user.id,
            username: user.username,
            isHost: user.isHost,
            isChatOnly: user.isChatOnly || false
          });
          
          // If host disconnected, notify viewers
          if (user.isHost) {
            // Notify only the non-chat-only users
            room.users.forEach(u => {
              if (!u.isChatOnly) {
                io.to(u.id).emit('hostConnectionLost', {
                  timestamp: now
                });
              }
            });
          }
        }
      }
    });
    
    // Cleanup old inactive users (disconnected for more than 5 minutes)
    room.users = room.users.filter(user => {
      if (user.active === false && now - user.disconnectedAt > 300000) {
        console.log(`Removing inactive user ${user.username} (${user.id}) from room ${roomId}`);
        return false;
      }
      return true;
    });
    
    // If room is empty or inactive for 30 minutes, remove it
    if (room.users.length === 0 || now - room.lastActive > 1800000) {
      delete rooms[roomId];
      console.log(`Removed inactive room ${roomId}`);
    }
  });
  
  // Clean up stale connection health data
  Object.keys(connectionHealth).forEach(socketId => {
    const health = connectionHealth[socketId];
    // If disconnected for more than 5 minutes, remove data
    if (!health.isConnected && now - health.disconnectedAt > 300000) {
      delete connectionHealth[socketId];
    }
  });
}, 15000);

// Create room endpoint
app.post('/create-room', (req, res) => {
  // Generate a random room ID
  const characters = '0123456789';
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

// Health check endpoint with enhanced diagnostics
app.get('/health', (req, res) => {
  // Basic system health metrics
  const healthData = {
    status: 'OK',
    uptime: process.uptime(),
    timestamp: Date.now(),
    rooms: Object.keys(rooms).length,
    connections: Object.keys(connectionHealth).filter(id => connectionHealth[id].isConnected).length,
    activeUsers: Object.values(rooms).reduce((count, room) => count + room.users.length, 0),
    chatOnlyUsers: Object.values(rooms).reduce((count, room) => 
      count + room.users.filter(user => user.isChatOnly).length, 0
    )
  };
  
  res.status(200).json(healthData);
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});