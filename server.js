const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();

// Enable CORS for all routes
app.use(cors());

// Increase payload size limits for JSON and URL-encoded data
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  },
  allowEIO3: true, // Allow compatibility with Socket.io v2 clients
  transports: ['websocket', 'polling'] // Enable all transports
});

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

// Track rooms and their video states
const rooms = {};

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
    const roomId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    const videoUrl = fixVideoUrl(`/uploads/${req.file.filename}`);
    
    // Initialize the room with the video URL
    rooms[roomId] = {
      videoState: {
        isPlaying: false,
        currentTime: 0,
        lastUpdate: Date.now()
      },
      users: [],
      videoUrl: videoUrl
    };
    
    console.log('Created room:', roomId, 'with video:', videoUrl);
    
    return res.status(200).json({ 
      success: true, 
      videoUrl: videoUrl,
      roomId: roomId
    });
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // User joins room
  socket.on('joinRoom', ({ roomId, username }) => {
    console.log(`User ${username} (${socket.id}) joining room ${roomId}`);
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
        videoUrl: null
      };
    } else {
      console.log(`Room ${roomId} exists with video URL:`, rooms[roomId].videoUrl);
    }
    
    // Add user to room
    rooms[roomId].users.push({
      id: socket.id,
      username
    });
    
    // Notify room about new user
    io.to(roomId).emit('userJoined', {
      user: { id: socket.id, username },
      users: rooms[roomId].users
    });
    
    // Send current video state to the new user
    socket.emit('videoStateUpdate', rooms[roomId].videoState);
    
    // Send video URL if available
    if (rooms[roomId].videoUrl) {
      console.log(`Sending existing video URL to new user ${username}:`, rooms[roomId].videoUrl);
      socket.emit('videoUrlUpdate', { videoUrl: rooms[roomId].videoUrl });
    } else {
      console.log(`No video URL available to send to user ${username}`);
    }
  });
  
  // Handle video state changes
  socket.on('videoStateChange', ({ roomId, videoState }) => {
    if (rooms[roomId]) {
      rooms[roomId].videoState = {
        ...videoState,
        lastUpdate: Date.now()
      };
      
      // Broadcast new state to everyone except sender
      socket.to(roomId).emit('videoStateUpdate', rooms[roomId].videoState);
    }
  });
  
  // Handle video URL updates (when host shares a video)
  socket.on('updateVideoUrl', ({ roomId, videoUrl }) => {
    console.log(`Received updateVideoUrl event for room ${roomId}:`, videoUrl);
    
    if (rooms[roomId]) {
      rooms[roomId].videoUrl = fixVideoUrl(videoUrl);
      console.log(`Updated video URL for room ${roomId}:`, rooms[roomId].videoUrl);
      
      // Broadcast new video URL to everyone in the room except the sender
      socket.to(roomId).emit('videoUrlUpdate', { videoUrl: rooms[roomId].videoUrl });
    } else {
      console.log(`Cannot update video URL for non-existent room: ${roomId}`);
    }
  });
  
  // Handle explicit video sharing from host (with more reliable delivery)
  socket.on('shareVideo', ({ roomId, videoUrl }) => {
    console.log(`Host is explicitly sharing video in room ${roomId}:`, videoUrl);
    
    if (rooms[roomId]) {
      rooms[roomId].videoUrl = fixVideoUrl(videoUrl);
      
      // Broadcast to EVERYONE in the room including sender to confirm
      io.to(roomId).emit('videoUrlUpdate', { videoUrl: rooms[roomId].videoUrl });
      console.log(`Broadcasted video URL to all users in room ${roomId}`);
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
        
        // Notify room about user leaving
        io.to(roomId).emit('userLeft', {
          userId: socket.id,
          username: user.username,
          users: room.users
        });
        
        // Clean up empty rooms
        if (room.users.length === 0) {
          delete rooms[roomId];
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all network interfaces

server.listen(PORT, HOST, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Local access: http://localhost:${PORT}/`);
  console.log(`Network access: http://YOUR_IP_ADDRESS:${PORT}/`);
  console.log(`Video files will be available in the /uploads/ directory`);
});