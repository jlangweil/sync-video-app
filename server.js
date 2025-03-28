const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// Enable CORS for all routes
app.use(cors());

// Increase timeouts for the Express server to handle WebRTC signaling
app.use((req, res, next) => {
  // Set timeout to 10 minutes for all requests
  req.setTimeout(600000);
  res.setTimeout(600000);
  next();
});

// Increase payload size limits for JSON and URL-encoded data
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const server = http.createServer(app);
// Increase the server timeout
server.setTimeout(600000); // 10 minutes

const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  },
  allowEIO3: true, // Allow compatibility with Socket.io v2 clients
  transports: ['websocket', 'polling'], // Enable all transports
  path: '/socket.io/'
});

// Create necessary directories
const chunksDir = path.join(__dirname, 'chunks');
const uploadsDir = path.join(__dirname, 'uploads');

[chunksDir, uploadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

// Helper function to generate shorter unique IDs
function generateUniqueId(length = 8) {
  // Use a combination of random characters for IDs
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Function to ensure the URL has the correct format
function fixVideoUrl(url) {
  if (!url) return url;
  
  // If it's already an absolute URL, return it
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  
  // Make sure it starts with a slash
  if (!url.startsWith('/')) {
    url = '/' + url;
  }
  
  console.log('Fixed video URL:', url);
  return url;
}

// Track rooms and their video states
const rooms = {};

// Initialize a room for a new video
app.post('/create-room', (req, res) => {
  // Generate a unique video ID and shorter roomId
  const videoId = generateUniqueId();
  const roomId = generateUniqueId(8); // 8 character room ID
  
  // Initialize the room with placeholder video URL (will be updated when chunks are received)
  rooms[roomId] = {
    videoState: {
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now()
    },
    users: [],
    videoUrl: null,
    hostId: null,
    videoId: videoId,
    uploadComplete: false,
    streamingInfo: {
      isStreaming: false,
      fileName: null,
      fileType: null
    }
  };
  
  console.log('Created room:', roomId, 'with pending videoId:', videoId);
  
  return res.status(200).json({ 
    success: true, 
    videoId: videoId,
    roomId: roomId
  });
});

// Handle chunk uploads
app.post('/upload-chunk', (req, res) => {
  // Increase timeout for this specific route
  req.setTimeout(300000); // 5 minutes
  
  const videoId = req.query.videoId;
  const roomId = req.query.roomId;
  const chunkIndex = parseInt(req.query.chunkIndex, 10);
  const totalChunks = parseInt(req.query.totalChunks, 10);
  
  if (!videoId || isNaN(chunkIndex) || isNaN(totalChunks)) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  console.log(`Receiving chunk ${chunkIndex + 1}/${totalChunks} for video ${videoId}`);
  
  // Set up chunk storage
  const videoChunkDir = path.join(chunksDir, videoId);
  if (!fs.existsSync(videoChunkDir)) {
    fs.mkdirSync(videoChunkDir, { recursive: true });
  }
  
  // Set up multer for this specific chunk
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, videoChunkDir);
    },
    filename: (req, file, cb) => {
      cb(null, `chunk-${chunkIndex}${path.extname(file.originalname)}`);
    }
  });
  
  const upload = multer({ storage }).single('chunk');
  
  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: err.message });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No chunk received' });
    }
    
    try {
      // If this is the first chunk, start creating the output file
      const outputFilePath = path.join(uploadsDir, `${videoId}.mp4`);
      
      // Create or append to the output file
      const chunkData = fs.readFileSync(path.join(videoChunkDir, req.file.filename));
      
      if (chunkIndex === 0) {
        // For the first chunk, create a new file
        fs.writeFileSync(outputFilePath, chunkData);
      } else {
        // For subsequent chunks, append to the existing file
        fs.appendFileSync(outputFilePath, chunkData);
      }
      
      // After saving the chunk, we can optionally delete it to save space
      fs.unlinkSync(path.join(videoChunkDir, req.file.filename));
      
      // Determine if this is the last chunk
      const isLastChunk = chunkIndex === totalChunks - 1;
      
      // Update the video URL in the room
      const videoUrl = `/videos/${videoId}.mp4`;
      
      if (roomId && rooms[roomId]) {
        // Update the video URL on the first chunk, so viewers can start watching immediately
        if (chunkIndex === 0 || !rooms[roomId].videoUrl) {
          rooms[roomId].videoUrl = videoUrl;
          io.to(roomId).emit('videoUrlUpdate', { videoUrl });
          console.log(`First chunk received, video URL set: ${videoUrl}, notified room ${roomId}`);
        }
        
        // If it's the last chunk, mark the upload as complete
        if (isLastChunk) {
          rooms[roomId].uploadComplete = true;
          io.to(roomId).emit('uploadComplete', { videoId, videoUrl });
          console.log(`Upload complete for video ${videoId} in room ${roomId}`);
        }
        
        // Notify the room about upload progress
        const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        io.to(roomId).emit('uploadProgress', { progress, videoId });
      }
      
      return res.status(200).json({ 
        success: true, 
        message: `Chunk ${chunkIndex + 1}/${totalChunks} processed`,
        videoId,
        videoUrl,
        isComplete: isLastChunk
      });
    } catch (error) {
      console.error('Error processing chunk:', error);
      return res.status(500).json({ 
        error: 'Error processing chunk',
        details: error.message
      });
    }
  });
});

// Set up storage for uploaded videos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      try {
        fs.mkdirSync(uploadDir, { recursive: true });
        console.log('Created uploads directory:', uploadDir);
      } catch (err) {
        console.error('Error creating uploads directory:', err);
      }
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

// Set up a simpler upload middleware
const upload = multer({
  storage: storage,
  limits: { fileSize: 5000000000 }, // 5GB limit
  fileFilter: (req, file, cb) => {
    // Accept all video files
    const filetypes = /mp4|webm|mov|avi|mkv|m4v|mp2|mpe|mpg|mpeg|mpv/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    // Less strict mimetype check
    const videoMimeType = file.mimetype.startsWith('video/');
    
    if (extname || videoMimeType) {
      return cb(null, true);
    }
    cb(new Error("Error: Videos Only! File type: " + file.mimetype));
  }
}).single('video');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Handle video upload with improved error handling
app.post('/upload', (req, res) => {
  console.log('Received upload request');
  
  upload(req, res, function(err) {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      console.error('Multer error:', err);
      return res.status(500).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      // An unknown error occurred
      console.error('Unknown error:', err);
      return res.status(500).json({ error: `Unknown error: ${err.message}` });
    }
    
    // Check if file exists
    if (!req.file) {
      console.error('No file received in the request');
      return res.status(400).json({ error: 'No file was selected or the file was empty' });
    }
    
    console.log('File details:', req.file);
    
    // Everything went fine
    const roomId = generateUniqueId(8); // Short room ID (8 chars)
    const videoUrl = fixVideoUrl(`/uploads/${req.file.filename}`);
    
    // Initialize the room with the video URL
    rooms[roomId] = {
      videoState: {
        isPlaying: false,
        currentTime: 0,
        lastUpdate: Date.now()
      },
      users: [],
      videoUrl: videoUrl,
      hostId: null,
      uploadComplete: true,
      streamingInfo: {
        isStreaming: false,
        fileName: null,
        fileType: null
      }
    };
    
    console.log('Created room:', roomId, 'with video:', videoUrl);
    
    return res.status(200).json({ 
      success: true, 
      videoUrl: videoUrl,
      roomId: roomId
    });
  });
});

// Serve videos with support for range requests (partial content)
app.get('/videos/:videoId', (req, res) => {
  const videoPath = path.join(uploadsDir, req.params.videoId);
  
  if (!fs.existsSync(videoPath)) {
    return res.status(404).send('Video not found');
  }
  
  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;
  
  if (range) {
    // Handle range request (partial content)
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    
    console.log(`Range request: ${start}-${end}/${fileSize} for ${req.params.videoId}`);
    
    const file = fs.createReadStream(videoPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    };
    
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    // Handle full file request
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    
    res.writeHead(200, head);
    fs.createReadStream(videoPath).pipe(res);
  }
});

// Add a new route for video deletion
app.delete('/videos/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  const roomId = req.query.roomId;
  
  // Security check - only allow deletion if requested by room host
  if (!roomId || !rooms[roomId]) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const socketId = req.query.socketId;
  if (socketId !== rooms[roomId].hostId) {
    return res.status(403).json({ error: 'Only the host can delete videos' });
  }
  
  const videoPath = path.join(uploadsDir, `${videoId}.mp4`);
  
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  try {
    // Delete the video file
    fs.unlinkSync(videoPath);
    
    // Also clean up any remaining chunks
    const chunkDir = path.join(chunksDir, videoId);
    if (fs.existsSync(chunkDir)) {
      // Delete all files in the chunk directory
      const files = fs.readdirSync(chunkDir);
      files.forEach(file => {
        fs.unlinkSync(path.join(chunkDir, file));
      });
      
      // Delete the directory
      fs.rmdirSync(chunkDir);
    }
    
    // Update room to indicate video is deleted
    if (rooms[roomId]) {
      rooms[roomId].videoUrl = null;
      rooms[roomId].videoDeleted = true;
      
      // Notify all users in the room
      io.to(roomId).emit('videoDeleted');
    }
    
    return res.status(200).json({ success: true, message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    return res.status(500).json({ error: 'Error deleting video' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // User joins room
  socket.on('joinRoom', ({ roomId, username, isHost }) => {
    console.log(`User ${username} (${socket.id}) joining room ${roomId}, isHost: ${isHost}`);
    socket.join(roomId);
    
    if (!rooms[roomId]) {
      console.log(`Room ${roomId} does not exist yet, creating it`);
      rooms[roomId] = {
        videoState: {
          isPlaying: false,
          currentTime: 0,
          lastUpdate: Date.now()
        },
        users: [],
        videoUrl: null,
        hostId: isHost ? socket.id : null,
        uploadComplete: false,
        streamingInfo: {
          isStreaming: false,
          fileName: null,
          fileType: null
        }
      };
    } else if (isHost && !rooms[roomId].hostId) {
      // If no host is assigned yet, this user becomes host
      rooms[roomId].hostId = socket.id;
      console.log(`User ${username} (${socket.id}) set as host for room ${roomId}`);
    }
    
    // Add user to room
    rooms[roomId].users.push({
      id: socket.id,
      username,
      isHost: isHost || socket.id === rooms[roomId].hostId
    });
    
    // Notify room about new user
    io.to(roomId).emit('userJoined', {
      user: { 
        id: socket.id, 
        username,
        isHost: isHost || socket.id === rooms[roomId].hostId 
      },
      users: rooms[roomId].users
    });
    
    // Send current video state to the new user
    socket.emit('videoStateUpdate', rooms[roomId].videoState);
    
    // Send video URL if available
    if (rooms[roomId].videoUrl) {
      console.log(`Sending existing video URL to new user ${username}:`, rooms[roomId].videoUrl);
      socket.emit('videoUrlUpdate', { videoUrl: rooms[roomId].videoUrl });
      
      // Also send upload status
      socket.emit('uploadStatus', { 
        complete: rooms[roomId].uploadComplete,
        videoId: rooms[roomId].videoId
      });
    } else {
      console.log(`No video URL available to send to user ${username}`);
    }
    
    // If there's an active stream, send streaming status
    if (rooms[roomId].streamingInfo.isStreaming) {
      socket.emit('streaming-status', {
        isStreaming: true,
        fileName: rooms[roomId].streamingInfo.fileName,
        fileType: rooms[roomId].streamingInfo.fileType
      });
    }
  });

  socket.on('streamingAboutToStart', ({ roomId }) => {
    if (rooms[roomId] && socket.id === rooms[roomId].hostId) {
      console.log(`Host ${socket.id} is preparing to stream in room ${roomId}`);
      // Notify all users in the room that streaming is about to start
      socket.to(roomId).emit('streamingAboutToStart');
    }
  });
  
  // WebRTC signaling handlers
  socket.on('webrtc-signal', ({ roomId, signal, to }) => {
    console.log(`Forwarding WebRTC signal from ${socket.id} to ${to}`);
    socket.to(to).emit('webrtc-signal', {
      signal,
      from: socket.id
    });
  });
  
  socket.on('request-stream', ({ roomId }) => {
    if (rooms[roomId]) {
      const hostId = rooms[roomId].hostId;
      if (hostId) {
        console.log(`User ${socket.id} requesting stream from host ${hostId} in room ${roomId}`);
        socket.to(hostId).emit('stream-requested', {
          from: socket.id,
          roomId
        });
      } else {
        console.log(`No host found for room ${roomId}`);
      }
    }
  });
  
  // Handle streaming status updates
  socket.on('streaming-status-update', ({ roomId, streaming, fileName, fileType }) => {
    if (rooms[roomId] && socket.id === rooms[roomId].hostId) {
      rooms[roomId].streamingInfo = {
        isStreaming: streaming,
        fileName,
        fileType
      };
      
      // Notify all users in the room
      io.to(roomId).emit('streaming-status', {
        isStreaming: streaming,
        fileName,
        fileType
      });
      
      console.log(`Updated streaming status for room ${roomId}: ${streaming ? 'Streaming' : 'Not streaming'} ${fileName || ''}`);
    }
  });
  
  // Handle video state changes - only allow from host
  socket.on('videoStateChange', ({ roomId, videoState, toUser }) => {
    if (rooms[roomId]) {
      // Only allow the host to control video state
      if (socket.id === rooms[roomId].hostId) {
        // Check if the state is significantly different to avoid loops
        const currentState = rooms[roomId].videoState;
        const isSignificantChange = 
          currentState.isPlaying !== videoState.isPlaying || 
          Math.abs(currentState.currentTime - videoState.currentTime) > 0.5;
        
        if (isSignificantChange) {
          console.log(`Host (${socket.id}) updated video state:`, videoState);
          
          rooms[roomId].videoState = {
            ...videoState,
            lastUpdate: Date.now()
          };
          
          // If a specific user is targeted, only send to them
          if (toUser) {
            socket.to(toUser).emit('videoStateUpdate', rooms[roomId].videoState);
          } else {
            // Broadcast new state to everyone EXCEPT the host
            // This prevents echoing back to the host and causing loops
            socket.to(roomId).emit('videoStateUpdate', rooms[roomId].videoState);
          }
        } else {
          console.log(`Ignoring minor state update from host to prevent loops`);
        }
      } else {
        console.log(`Rejected video state change from non-host user: ${socket.id}`);
        
        // Send the current state back to the non-host user to force sync
        socket.emit('videoStateUpdate', rooms[roomId].videoState);
      }
    }
  });
  
  // Handle video URL updates (when host shares a video)
  socket.on('updateVideoUrl', ({ roomId, videoUrl }) => {
    console.log(`Received updateVideoUrl event for room ${roomId}:`, videoUrl);
    
    if (rooms[roomId]) {
      // Only allow host to update video URL
      if (socket.id === rooms[roomId].hostId) {
        rooms[roomId].videoUrl = fixVideoUrl(videoUrl);
        console.log(`Host updated video URL for room ${roomId}:`, rooms[roomId].videoUrl);
        
        // Broadcast new video URL to everyone in the room except the sender
        socket.to(roomId).emit('videoUrlUpdate', { videoUrl: rooms[roomId].videoUrl });
      } else {
        console.log(`Rejected video URL update from non-host user: ${socket.id}`);
      }
    } else {
      console.log(`Cannot update video URL for non-existent room: ${roomId}`);
    }
  });
  
  // Handle explicit video sharing from host (with more reliable delivery)
  socket.on('shareVideo', ({ roomId, videoUrl }) => {
    console.log(`Host is explicitly sharing video in room ${roomId}:`, videoUrl);
    
    if (rooms[roomId]) {
      // Only allow host to share videos
      if (socket.id === rooms[roomId].hostId) {
        rooms[roomId].videoUrl = fixVideoUrl(videoUrl);
        
        // Broadcast to EVERYONE in the room including sender to confirm
        io.to(roomId).emit('videoUrlUpdate', { videoUrl: rooms[roomId].videoUrl });
        console.log(`Broadcasted video URL to all users in room ${roomId}`);
      } else {
        console.log(`Rejected video sharing from non-host user: ${socket.id}`);
      }
    }
  });
  
  // Handle video deletion requests
  socket.on('deleteVideo', ({ roomId, videoId }) => {
    console.log(`Request to delete video ${videoId} from room ${roomId}`);
    
    // Check if user is the host
    if (!roomId || !rooms[roomId] || socket.id !== rooms[roomId].hostId) {
      console.log(`Rejected video deletion from non-host user: ${socket.id}`);
      return;
    }
    
    const videoPath = path.join(uploadsDir, `${videoId}.mp4`);
    
    if (fs.existsSync(videoPath)) {
      try {
        // Delete the video file
        fs.unlinkSync(videoPath);
        
        // Clean up any remaining chunks
        const chunkDir = path.join(chunksDir, videoId);
        if (fs.existsSync(chunkDir)) {
          const files = fs.readdirSync(chunkDir);
          files.forEach(file => {
            fs.unlinkSync(path.join(chunkDir, file));
          });
          fs.rmdirSync(chunkDir);
        }
        
        // Update room status
        rooms[roomId].videoUrl = null;
        rooms[roomId].videoDeleted = true;
        
        // Notify all users in the room
        io.to(roomId).emit('videoDeleted');
        
        console.log(`Video ${videoId} deleted successfully`);
      } catch (error) {
        console.error('Error deleting video:', error);
      }
    } else {
      console.log(`Video file not found: ${videoPath}`);
    }
  });
  
  // Handle chat messages
  socket.on('sendMessage', ({ roomId, message, username }) => {
    io.to(roomId).emit('newMessage', {
      user: username,
      text: message,
      time: new Date().toLocaleTimeString()
    });
  });
  
  // Handle disconnections
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Remove user from all rooms they were in
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      const userIndex = room.users.findIndex(user => user.id === socket.id);
      
      if (userIndex !== -1) {
        const user = room.users[userIndex];
        room.users.splice(userIndex, 1);
        
        // If the host disconnects, try to assign a new host
        if (room.hostId === socket.id && room.users.length > 0) {
          room.hostId = room.users[0].id;
          room.users[0].isHost = true;
          console.log(`Host disconnected. New host assigned: ${room.hostId}`);
          
          // Notify everyone about the new host
          io.to(roomId).emit('systemMessage', {
            text: `${user.username} (host) has left. ${room.users[0].username} is now the host.`
          });
        }
        
        // Notify room about user leaving
        io.to(roomId).emit('userLeft', {
          userId: socket.id,
          username: user.username,
          users: room.users
        });
        
        // Clean up empty rooms
        if (room.users.length === 0) {
          delete rooms[roomId];
          console.log(`Room ${roomId} deleted as it's now empty`);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0'; // Listen on all network interfaces

server.listen(PORT, HOST, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Local access: http://localhost:${PORT}/`);
  console.log(`Network access: http://YOUR_IP_ADDRESS:${PORT}/`);
  console.log(`Video files will be available in the /uploads/ directory`);
});