const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_me';

// Short-lived access token (sent with every API request) + long-lived refresh
// token (stored only as an httpOnly cookie, used solely to mint new access
// tokens). This limits how long a stolen access token stays useful, without
// forcing the user to re-login every 15 minutes.
const ACCESS_TOKEN_EXPIRES = '15m';
const REFRESH_TOKEN_EXPIRES = '7d';
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES }
  );
}

function signRefreshToken(user) {
  return jwt.sign({ id: user.id }, REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET); // throws if invalid/expired
}

// The refresh token itself is stored hashed in the database (same pattern as
// passwords) so that even a database leak doesn't expose usable tokens, and
// so a single stored hash can be invalidated to revoke a session (logout).
async function hashRefreshToken(token) {
  return bcrypt.hash(token, 10);
}

async function compareRefreshToken(token, hash) {
  if (!hash) return false;
  return bcrypt.compare(token, hash);
}

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  path: '/api/auth',
};

function protect(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authorized, no token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, ACCESS_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden: insufficient role permissions' });
    }
    next();
  };
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
  compareRefreshToken,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
  protect,
  authorize,
};
