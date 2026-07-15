require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const cookieParser = require('cookie-parser');
const connectDB = require('./src/config');
const apiRoutes = require('./src/routes');
const { initSocket } = require('./src/socket');

const app = express();
const server = http.createServer(app);
initSocket(server);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api', apiRoutes);

// Any non-API route falls back to the single-page app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log(`  Smart AI Bug Tracker is running!`);
    console.log(`  Open http://localhost:${PORT} in your browser`);
    console.log('');
  });
});
