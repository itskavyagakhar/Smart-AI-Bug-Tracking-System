const { Server } = require('socket.io');
const Notification = require('./models/Notification');
const User = require('./models/User');
const { sendNotificationEmail } = require('./emailService');

let io;

// The app is served from a single origin (server.js serves both the API and
// the frontend), so Socket.io needs no cross-origin allowlist — it just needs
// to be attached to the same HTTP server.
function initSocket(server) {
  io = new Server(server);

  io.on('connection', (socket) => {
    // Each logged-in user joins a private room keyed by their own user id,
    // so notifications can be sent to exactly one person.
    socket.on('join', (userId) => {
      if (userId) socket.join(userId);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

// Persists a notification to the database, pushes it in real-time to the
// recipient if they're currently connected, and also emails them (if SMTP is
// configured — silently skipped otherwise). Safe to call even if the
// recipient is offline — they'll see it next time they load notifications.
async function notifyUser(userId, text, bugId = null) {
  try {
    if (!userId) return;

    const notification = await Notification.create({ user: userId, text, bug: bugId });

    if (io) {
      io.to(userId.toString()).emit('notification', notification.toJSON());
    }

    const user = await User.findById(userId).select('email name');
    if (user) {
      sendNotificationEmail(user.email, user.name, text); // fire-and-forget, never awaited/blocking
    }
  } catch (err) {
    console.error('Failed to send notification:', err.message);
  }
}

module.exports = { initSocket, getIO, notifyUser };
