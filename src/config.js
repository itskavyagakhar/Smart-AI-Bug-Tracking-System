const mongoose = require('mongoose');
const dns = require('dns');

// Some Windows/router/network setups fail Node's internal SRV DNS lookups
// (used by mongodb+srv:// URIs) even though the OS resolver works fine.
// Pointing Node's resolver at public DNS servers fixes this reliably.
dns.setServers(['8.8.8.8', '8.8.4.4']);

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set in .env — cannot start without a database connection.');
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected successfully');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
