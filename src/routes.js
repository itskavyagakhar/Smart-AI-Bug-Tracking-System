const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const User = require('./models/User');
const Project = require('./models/Project');
const Bug = require('./models/Bug');
const BugHistory = require('./models/BugHistory');
const Notification = require('./models/Notification');
const Comment = require('./models/Comment');

const {
  hashPassword, comparePassword, signToken, protect, authorize,
  signRefreshToken, verifyRefreshToken, hashRefreshToken, compareRefreshToken,
  REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS,
} = require('./auth');
const { notifyUser } = require('./socket');
const { upload } = require('./upload');
const {
  generateDescription,
  predictSeverityPriority,
  generateFixSuggestion,
  generateTestCases,
  generateRootCauseAnalysis,
  generateSummary,
  detectDuplicate,
  answerBugQuestion,
} = require('./geminiService');

const ALLOWED_TRANSITIONS = {
  Open: ['In Progress'],
  'In Progress': ['Ready For Testing'],
  'Ready For Testing': ['Closed', 'Reopened'],
  Reopened: ['In Progress'],
  Closed: [],
};

const logHistory = (bugId, action, userId) => BugHistory.create({ bug: bugId, action, user: userId });

/* ---------------- AUTH ---------------- */

// Public: tells the frontend whether this is a fresh install (no users yet),
// so it can show a one-time "Create Admin Account" setup screen instead of Login.
router.get('/auth/bootstrap-status', async (req, res) => {
  const count = await User.countDocuments();
  res.json({ needsSetup: count === 0 });
});

// Registration is locked down: allowed only in two cases —
// 1) No users exist yet at all (first-run setup) -> always creates an Admin, ignoring any role in the body.
// 2) The request carries a valid Admin JWT -> that Admin can create a user with any role.
// There is no public "Register" page; this endpoint is only ever called by the
// first-run setup screen or by the Users management page (Admin only).
// Issues an access token + refresh token pair for a freshly authenticated user:
// stores a hash of the refresh token on the user doc (so it can be revoked on
// logout, and rotated on each /auth/refresh call), and sets it as an httpOnly
// cookie scoped to /api/auth so the browser sends it automatically only to
// the refresh/logout endpoints.
async function issueTokens(res, user) {
  const accessToken = signToken({ id: user._id, role: user.role, name: user.name, email: user.email });
  const refreshToken = signRefreshToken({ id: user._id });

  user.refreshTokenHash = await hashRefreshToken(refreshToken);
  await user.save();

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
  return accessToken;
}

router.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    let { role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }

    const userCount = await User.countDocuments();
    let isBootstrap = false;

    if (userCount === 0) {
      isBootstrap = true;
      role = 'Admin'; // first user is always Admin, regardless of what was sent
    } else {
      // Not a bootstrap — require a valid Admin token to create further users
      const authHeader = req.headers.authorization;
      const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
      if (!token) return res.status(401).json({ message: 'Not authorized to create users' });

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
      } catch (e) {
        return res.status(401).json({ message: 'Not authorized to create users' });
      }
      if (decoded.role !== 'Admin') {
        return res.status(403).json({ message: 'Only an Admin can create new users' });
      }
      if (!['Admin', 'QA', 'Developer'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
      }
    }

    const emailLower = email.toLowerCase();
    const existing = await User.findOne({ email: emailLower });
    if (existing) return res.status(409).json({ message: 'A user with this email already exists' });

    const hashed = await hashPassword(password);
    const user = await User.create({ name, email: emailLower, password: hashed, role });

    // Only log the caller in automatically during first-run bootstrap. When an
    // Admin creates a QA/Developer from the Users page, we must NOT overwrite
    // the Admin's own session with a token/cookie for the new account.
    let token;
    if (isBootstrap) {
      token = await issueTokens(res, user);
    } else {
      token = signToken({ id: user._id, role: user.role, name: user.name, email: user.email });
    }

    res.status(201).json({ token, user, isBootstrap });
  } catch (err) {
    res.status(500).json({ message: 'Registration failed', error: err.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });

    const match = await comparePassword(password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid email or password' });

    const token = await issueTokens(res, user);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ message: 'Login failed', error: err.message });
  }
});

// Exchanges a valid refresh-token cookie for a new access token, rotating the
// refresh token in the process (old one is invalidated as soon as a new one
// is issued, since we only ever store one hash per user).
router.post('/auth/refresh', async (req, res) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!token) return res.status(401).json({ message: 'No refresh token provided' });

    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch (e) {
      return res.status(401).json({ message: 'Refresh token invalid or expired' });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'User not found' });

    const validRefresh = await compareRefreshToken(token, user.refreshTokenHash);
    if (!validRefresh) return res.status(401).json({ message: 'Refresh token has been revoked' });

    const accessToken = await issueTokens(res, user); // rotates the refresh token too
    res.json({ token: accessToken });
  } catch (err) {
    res.status(500).json({ message: 'Failed to refresh token', error: err.message });
  }
});

router.post('/auth/logout', async (req, res) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (token) {
      try {
        const decoded = verifyRefreshToken(token);
        await User.findByIdAndUpdate(decoded.id, { refreshTokenHash: null });
      } catch (e) {
        // Token already invalid/expired — nothing to revoke, just clear the cookie below.
      }
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ message: 'Logout failed', error: err.message });
  }
});

router.get('/auth/me', protect, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user);
});

// Self-service profile update — a user can change their own name and/or password.
// Changing the password requires the current password for confirmation.
router.put('/auth/profile', protect, async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name && name.trim()) user.name = name.trim();

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Current password is required to set a new password' });
      }
      const match = await comparePassword(currentPassword, user.password);
      if (!match) return res.status(401).json({ message: 'Current password is incorrect' });
      if (newPassword.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters' });
      }
      user.password = await hashPassword(newPassword);
    }

    await user.save();
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update profile', error: err.message });
  }
});

router.get('/auth/users', protect, async (req, res) => {
  const { role } = req.query;
  const filter = role ? { role } : {};
  const users = await User.find(filter);
  res.json(users);
});

/* ---------------- PROJECTS ---------------- */

router.post('/projects', protect, authorize('Admin'), async (req, res) => {
  try {
    const { name, description, startDate, endDate, qaMembers, developers } = req.body;
    if (!name || !description) return res.status(400).json({ message: 'name and description are required' });

    const project = await Project.create({
      name,
      description,
      startDate: startDate || null,
      endDate: endDate || null,
      qaMembers: qaMembers || [],
      developers: developers || [],
      createdBy: req.user.id,
    });

    const populated = await project.populate([
      { path: 'qaMembers' }, { path: 'developers' }, { path: 'createdBy' },
    ]);
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to create project', error: err.message });
  }
});

router.get('/projects', protect, async (req, res) => {
  try {
    let filter = {};
    if (req.user.role === 'QA') filter = { qaMembers: req.user.id };
    else if (req.user.role === 'Developer') filter = { developers: req.user.id };

    const projects = await Project.find(filter)
      .populate('qaMembers')
      .populate('developers')
      .populate('createdBy')
      .sort({ createdAt: -1 });

    res.json(projects);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch projects', error: err.message });
  }
});

router.get('/projects/:id', protect, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('qaMembers')
      .populate('developers')
      .populate('createdBy');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch project', error: err.message });
  }
});

router.put('/projects/:id', protect, authorize('Admin'), async (req, res) => {
  try {
    const project = await Project.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('qaMembers').populate('developers').populate('createdBy');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update project', error: err.message });
  }
});

router.delete('/projects/:id', protect, authorize('Admin'), async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    const bugs = await Bug.find({ project: project._id });
    await BugHistory.deleteMany({ bug: { $in: bugs.map((b) => b._id) } });
    await Bug.deleteMany({ project: project._id });
    res.json({ message: 'Project and its bugs deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete project', error: err.message });
  }
});

/* ---------------- BUGS ---------------- */

const populateBug = (query) => query.populate('project').populate('assignedDeveloper').populate('createdBy');

router.post('/bugs', protect, authorize('QA'), async (req, res) => {
  try {
    const {
      title, description, project, module: bugModule, environment,
      severity, priority, stepsToReproduce, expectedResult, actualResult,
      aiSeverityReason, aiPriorityReason, aiSummary,
    } = req.body;

    if (!title || !description || !project) {
      return res.status(400).json({ message: 'title, description and project are required' });
    }

    const projectDoc = await Project.findById(project);
    if (!projectDoc) return res.status(404).json({ message: 'Project not found' });

    const count = await Bug.countDocuments();
    const bugId = `BUG-${String(count + 1).padStart(4, '0')}`;

    const bug = await Bug.create({
      bugId,
      title,
      description,
      project,
      module: bugModule || '',
      environment: environment || 'Development',
      severity: severity || 'Medium',
      priority: priority || 'Medium',
      aiSeverityReason: aiSeverityReason || '',
      aiPriorityReason: aiPriorityReason || '',
      aiSummary: aiSummary || '',
      stepsToReproduce: stepsToReproduce || [],
      expectedResult: expectedResult || '',
      actualResult: actualResult || '',
      status: 'Open',
      createdBy: req.user.id,
    });

    await logHistory(bug._id, 'Bug Created', req.user.id);

    const populated = await populateBug(Bug.findById(bug._id));
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to create bug', error: err.message });
  }
});

router.get('/bugs', protect, async (req, res) => {
  try {
    const { project, status, severity, priority, assignedDeveloper, search } = req.query;
    const filter = {};

    if (project) filter.project = project;
    if (status) filter.status = status;
    if (severity) filter.severity = severity;
    if (priority) filter.priority = priority;
    if (assignedDeveloper) filter.assignedDeveloper = assignedDeveloper;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { bugId: { $regex: search, $options: 'i' } },
      ];
    }
    if (req.user.role === 'Developer') filter.assignedDeveloper = req.user.id;

    const bugs = await populateBug(Bug.find(filter)).sort({ createdAt: -1 });
    res.json(bugs);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch bugs', error: err.message });
  }
});

router.get('/bugs/dashboard/stats', protect, async (req, res) => {
  try {
    const role = req.user.role;
    const uid = req.user.id;

    if (role === 'Admin') {
      const [totalProjects, totalBugs, open, inProgress, closed] = await Promise.all([
        Project.countDocuments(),
        Bug.countDocuments(),
        Bug.countDocuments({ status: 'Open' }),
        Bug.countDocuments({ status: 'In Progress' }),
        Bug.countDocuments({ status: 'Closed' }),
      ]);
      return res.json({ totalProjects, totalBugs, open, inProgress, closed });
    }
    if (role === 'QA') {
      const [created, open, reopened, closed] = await Promise.all([
        Bug.countDocuments({ createdBy: uid }),
        Bug.countDocuments({ createdBy: uid, status: 'Open' }),
        Bug.countDocuments({ createdBy: uid, status: 'Reopened' }),
        Bug.countDocuments({ createdBy: uid, status: 'Closed' }),
      ]);
      return res.json({ created, open, reopened, closed });
    }
    if (role === 'Developer') {
      const [assigned, inProgress, readyForTesting] = await Promise.all([
        Bug.countDocuments({ assignedDeveloper: uid }),
        Bug.countDocuments({ assignedDeveloper: uid, status: 'In Progress' }),
        Bug.countDocuments({ assignedDeveloper: uid, status: 'Ready For Testing' }),
      ]);
      return res.json({ assigned, inProgress, readyForTesting });
    }
    res.status(400).json({ message: 'Unknown role' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch dashboard stats', error: err.message });
  }
});

router.get('/bugs/dashboard/recent-activity', protect, async (req, res) => {
  try {
    let bugFilter = {};
    if (req.user.role === 'QA') bugFilter = { createdBy: req.user.id };
    else if (req.user.role === 'Developer') bugFilter = { assignedDeveloper: req.user.id };

    const scopedBugIds = req.user.role === 'Admin' ? null : (await Bug.find(bugFilter).select('_id')).map((b) => b._id);

    const historyFilter = scopedBugIds ? { bug: { $in: scopedBugIds } } : {};
    const entries = await BugHistory.find(historyFilter)
      .populate('bug')
      .populate('user')
      .sort({ timestamp: -1 })
      .limit(8);

    const result = entries.map((h) => ({
      id: h.id,
      action: h.action,
      timestamp: h.timestamp,
      bugId: h.bug ? h.bug.bugId : null,
      bugTitle: h.bug ? h.bug.title : null,
      userName: h.user ? h.user.name : null,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch recent activity', error: err.message });
  }
});

// Aggregated data for the Reports page: bugs by status, by severity, by priority,
// and a daily count for the last 14 days — all scoped the same way as dashboard stats.
router.get('/reports/summary', protect, async (req, res) => {
  try {
    let filter = {};
    if (req.user.role === 'QA') filter = { createdBy: req.user.id };
    else if (req.user.role === 'Developer') filter = { assignedDeveloper: req.user.id };

    const bugs = await Bug.find(filter).select('status severity priority createdAt');

    const countBy = (key) => {
      const counts = {};
      bugs.forEach((b) => { counts[b[key]] = (counts[b[key]] || 0) + 1; });
      return counts;
    };

    const byStatus = countBy('status');
    const bySeverity = countBy('severity');
    const byPriority = countBy('priority');

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push(d);
    }
    const trend = days.map((day) => {
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      const count = bugs.filter((b) => b.createdAt >= day && b.createdAt < next).length;
      return { date: day.toISOString().slice(0, 10), count };
    });

    res.json({ total: bugs.length, byStatus, bySeverity, byPriority, trend });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch report summary', error: err.message });
  }
});

router.get('/bugs/:id', protect, async (req, res) => {
  try {
    const bug = await populateBug(Bug.findById(req.params.id));
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const history = await BugHistory.find({ bug: bug.id }).populate('user').sort({ timestamp: 1 });
    const comments = await Comment.find({ bug: bug.id }).populate('user').sort({ createdAt: 1 });
    res.json({ bug, history, comments });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch bug', error: err.message });
  }
});

router.put('/bugs/:id', protect, authorize('QA'), async (req, res) => {
  try {
    const bug = await populateBug(Bug.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }));
    if (!bug) return res.status(404).json({ message: 'Bug not found' });
    await logHistory(bug.id, 'Bug Details Updated', req.user.id);
    res.json(bug);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update bug', error: err.message });
  }
});

router.delete('/bugs/:id', protect, authorize('QA', 'Admin'), async (req, res) => {
  try {
    const bug = await Bug.findByIdAndDelete(req.params.id);
    if (!bug) return res.status(404).json({ message: 'Bug not found' });
    await BugHistory.deleteMany({ bug: bug._id });
    res.json({ message: 'Bug deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete bug', error: err.message });
  }
});

router.put('/bugs/:id/assign', protect, authorize('QA'), async (req, res) => {
  try {
    const { developerId } = req.body;
    if (!developerId) return res.status(400).json({ message: 'developerId is required' });

    const bug = await populateBug(Bug.findByIdAndUpdate(
      req.params.id,
      { assignedDeveloper: developerId, assignedDate: new Date() },
      { new: true }
    ));
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    await logHistory(bug.id, 'Bug Assigned to Developer', req.user.id);
    await notifyUser(developerId, `You were assigned to ${bug.bugId}: "${bug.title}"`, bug.id);
    res.json(bug);
  } catch (err) {
    res.status(500).json({ message: 'Failed to assign bug', error: err.message });
  }
});

router.put('/bugs/:id/status', protect, authorize('QA', 'Developer'), async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['Open', 'In Progress', 'Ready For Testing', 'Closed', 'Reopened'];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Invalid status value' });

    const bug = await Bug.findById(req.params.id);
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const allowedNext = ALLOWED_TRANSITIONS[bug.status] || [];
    if (!allowedNext.includes(status)) {
      return res.status(400).json({
        message: `Invalid transition from '${bug.status}' to '${status}'. Allowed: ${allowedNext.join(', ') || 'none'}`,
      });
    }

    bug.status = status;
    await bug.save();
    await logHistory(bug.id, `Status changed to ${status}`, req.user.id);

    // Notify whichever side didn't make the change: if QA (the reporter) changed it,
    // notify the assigned developer; if the developer changed it, notify the reporter.
    const changerIsReporter = bug.createdBy.toString() === req.user.id;
    const recipientId = changerIsReporter ? bug.assignedDeveloper : bug.createdBy;
    if (recipientId && recipientId.toString() !== req.user.id) {
      await notifyUser(recipientId, `${bug.bugId} was moved to "${status}"`, bug.id);
    }

    const populated = await populateBug(Bug.findById(bug._id));
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update bug status', error: err.message });
  }
});

/* ---------------- ATTACHMENTS ---------------- */

router.post('/bugs/:id/attachments', protect, upload.array('files', 5), async (req, res) => {
  try {
    const bug = await Bug.findById(req.params.id);
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files were uploaded' });
    }

    const newAttachments = req.files.map((f) => ({
      filename: f.originalname,
      filepath: `/uploads/${f.filename}`,
      uploadedBy: req.user.id,
      uploadedAt: new Date(),
    }));

    bug.attachments.push(...newAttachments);
    await bug.save();
    await logHistory(bug.id, `Attached ${newAttachments.length} file(s)`, req.user.id);

    const populated = await populateBug(Bug.findById(bug._id));
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to upload attachment', error: err.message });
  }
});

router.delete('/bugs/:id/attachments/:attachmentId', protect, async (req, res) => {
  try {
    const bug = await Bug.findById(req.params.id);
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    bug.attachments = bug.attachments.filter((a) => a._id.toString() !== req.params.attachmentId);
    await bug.save();

    const populated = await populateBug(Bug.findById(bug._id));
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete attachment', error: err.message });
  }
});

/* ---------------- NOTIFICATIONS ---------------- */

router.get('/notifications', protect, async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(30);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch notifications', error: err.message });
  }
});

router.put('/notifications/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ message: 'Notification not found' });
    res.json(notification);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update notification', error: err.message });
  }
});

router.put('/notifications/read-all', protect, async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update notifications', error: err.message });
  }
});



/* ---------------- COMMENTS ---------------- */

async function notifyCommentParticipants(bug, posterId, text) {
  const recipients = new Set();
  if (bug.createdBy) recipients.add(bug.createdBy.toString());
  if (bug.assignedDeveloper) recipients.add(bug.assignedDeveloper.toString());
  recipients.delete(posterId.toString());
  for (const uid of recipients) {
    await notifyUser(uid, `New comment on ${bug.bugId}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`, bug.id);
  }
}

router.post('/bugs/:id/comments', protect, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ message: 'Comment text is required' });

    const bug = await Bug.findById(req.params.id);
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const comment = await Comment.create({ bug: bug._id, user: req.user.id, text: text.trim() });
    const populated = await comment.populate('user');

    await notifyCommentParticipants(bug, req.user.id, text.trim());

    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to add comment', error: err.message });
  }
});

router.post('/comments/:commentId/replies', protect, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ message: 'Reply text is required' });

    const parent = await Comment.findById(req.params.commentId);
    if (!parent) return res.status(404).json({ message: 'Comment not found' });

    const bug = await Bug.findById(parent.bug);
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const reply = await Comment.create({
      bug: parent.bug,
      user: req.user.id,
      text: text.trim(),
      parentComment: parent._id,
    });
    const populated = await reply.populate('user');

    // Notify the original commenter too, in addition to the usual bug participants.
    if (parent.user.toString() !== req.user.id) {
      await notifyUser(parent.user, `${(populated.user.name)} replied to your comment on ${bug.bugId}`, bug.id.toString());
    }
    await notifyCommentParticipants(bug, req.user.id, text.trim());

    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to add reply', error: err.message });
  }
});

router.delete('/comments/:commentId', protect, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    if (comment.user.toString() !== req.user.id && req.user.role !== 'Admin') {
      return res.status(403).json({ message: 'You can only delete your own comments' });
    }

    await Comment.deleteMany({ $or: [{ _id: comment._id }, { parentComment: comment._id }] });
    res.json({ message: 'Comment deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete comment', error: err.message });
  }
});



/* ---------------- AI ---------------- */

router.post('/ai/generate-description', protect, authorize('QA'), async (req, res) => {
  try {
    const { projectId, title, stepsToReproduce } = req.body;
    if (!projectId || !title) return res.status(400).json({ message: 'projectId and title are required' });

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const result = await generateDescription({
      projectName: project.name,
      projectDescription: project.description,
      title,
      stepsToReproduce: stepsToReproduce || [],
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI generation failed', error: err.message });
  }
});

router.post('/ai/predict-severity-priority', protect, authorize('QA'), async (req, res) => {
  try {
    const { projectId, title, description } = req.body;
    if (!projectId || !title || !description) {
      return res.status(400).json({ message: 'projectId, title and description are required' });
    }

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const result = await predictSeverityPriority({
      projectName: project.name,
      projectDescription: project.description,
      title,
      description,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI prediction failed', error: err.message });
  }
});

router.post('/ai/bugs/:id/test-cases', protect, authorize('QA'), async (req, res) => {
  try {
    const bug = await Bug.findById(req.params.id).populate('project');
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const result = await generateTestCases({
      projectName: bug.project?.name,
      projectDescription: bug.project?.description,
      title: bug.title,
      description: bug.description,
    });

    bug.testCases = result;
    await bug.save();
    await logHistory(bug.id, 'AI Test Cases Generated', req.user.id);

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI test case generation failed', error: err.message });
  }
});

router.post('/ai/bugs/:id/fix-suggestion', protect, authorize('Developer', 'QA'), async (req, res) => {
  try {
    const bug = await Bug.findById(req.params.id).populate('project');
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const result = await generateFixSuggestion({
      projectName: bug.project?.name,
      projectDescription: bug.project?.description,
      title: bug.title,
      description: bug.description,
      stepsToReproduce: bug.stepsToReproduce,
    });

    bug.fixSuggestion = result;
    await bug.save();
    await logHistory(bug.id, 'AI Fix Suggestion Generated', req.user.id);

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI fix suggestion failed', error: err.message });
  }
});

router.post('/ai/bugs/:id/root-cause', protect, authorize('Developer'), async (req, res) => {
  try {
    const bug = await Bug.findById(req.params.id).populate('project');
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const result = await generateRootCauseAnalysis({
      projectName: bug.project?.name,
      projectDescription: bug.project?.description,
      title: bug.title,
      description: bug.description,
      stepsToReproduce: bug.stepsToReproduce,
    });

    bug.rootCauseAnalysis = result;
    await bug.save();
    await logHistory(bug.id, 'AI Root Cause Analysis Generated', req.user.id);

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI root cause analysis failed', error: err.message });
  }
});

// 7. AI Bug Summary — condense a raw description into one clean sentence (ephemeral, used while composing)
router.post('/ai/generate-summary', protect, authorize('QA'), async (req, res) => {
  try {
    const { projectId, description } = req.body;
    if (!projectId || !description) {
      return res.status(400).json({ message: 'projectId and description are required' });
    }

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const result = await generateSummary({
      projectName: project.name,
      projectDescription: project.description,
      description,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI summary generation failed', error: err.message });
  }
});

// 8. Duplicate Bug Detection — checks a new bug against existing bugs in the same project (ephemeral)
router.post('/ai/detect-duplicate', protect, authorize('QA'), async (req, res) => {
  try {
    const { projectId, title, description } = req.body;
    if (!projectId || !title || !description) {
      return res.status(400).json({ message: 'projectId, title and description are required' });
    }

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const existingBugs = await Bug.find({ project: projectId }).select('bugId title description').limit(50);

    const result = await detectDuplicate({
      projectName: project.name,
      projectDescription: project.description,
      title,
      description,
      existingBugs: existingBugs.map((b) => ({ bugId: b.bugId, title: b.title, description: b.description })),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI duplicate detection failed', error: err.message });
  }
});

// 9. AI Chat Assistant — free-form Q&A about a specific bug (ephemeral, any authenticated role)
router.post('/ai/bugs/:id/ask', protect, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ message: 'question is required' });

    const bug = await Bug.findById(req.params.id).populate('project').populate('assignedDeveloper').populate('createdBy');
    if (!bug) return res.status(404).json({ message: 'Bug not found' });

    const bugContext = [
      `Bug ID: ${bug.bugId}`,
      `Title: ${bug.title}`,
      `Description: ${bug.description}`,
      `Status: ${bug.status}`,
      `Severity: ${bug.severity}${bug.aiSeverityReason ? ` (reason: ${bug.aiSeverityReason})` : ''}`,
      `Priority: ${bug.priority}${bug.aiPriorityReason ? ` (reason: ${bug.aiPriorityReason})` : ''}`,
      `Project: ${bug.project?.name || ''}`,
      bug.stepsToReproduce?.length ? `Steps to Reproduce: ${bug.stepsToReproduce.join('; ')}` : '',
      bug.expectedResult ? `Expected Result: ${bug.expectedResult}` : '',
      bug.actualResult ? `Actual Result: ${bug.actualResult}` : '',
      bug.assignedDeveloper ? `Assigned Developer: ${bug.assignedDeveloper.name}` : 'Assigned Developer: Unassigned',
      bug.fixSuggestion ? `Fix Suggestion already generated: ${JSON.stringify(bug.fixSuggestion)}` : '',
      bug.rootCauseAnalysis ? `Root Cause Analysis already generated: ${JSON.stringify(bug.rootCauseAnalysis)}` : '',
    ].filter(Boolean).join('\n');

    const result = await answerBugQuestion({ bugContext, question });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'AI chat assistant failed', error: err.message });
  }
});

module.exports = router;
