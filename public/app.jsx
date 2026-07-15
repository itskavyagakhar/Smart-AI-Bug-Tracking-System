const { useState, useEffect, useCallback, createContext, useContext } = React;

/* ---------------- API helper ---------------- */

// Attempts to swap the refresh-token cookie for a new access token. Returns
// the new token on success, or null on failure (refresh cookie missing,
// expired, or revoked) — callers fall back to a full logout in that case.
let refreshInFlight = null; // de-dupes concurrent refresh attempts from parallel requests
async function tryRefreshToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.token) {
        localStorage.setItem('token', data.token);
        return data.token;
      }
      return null;
    } catch (e) {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function forceLogout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.reload();
}

async function apiFetch(path, options = {}, _isRetry = false) {
  const token = localStorage.getItem('token');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers, credentials: 'include' });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    // If we had a token, the access token likely just expired (they're short-lived
    // by design) — try a silent refresh once before giving up and logging out.
    if (token && !_isRetry) {
      const newToken = await tryRefreshToken();
      if (newToken) {
        return apiFetch(path, options, true); // retry the original request exactly once
      }
      forceLogout();
      throw new Error('Your session has expired. Please log in again.');
    }
    if (token) {
      forceLogout();
      throw new Error('Your session has expired. Please log in again.');
    }
    // No token was sent at all — this is a normal auth failure (e.g. wrong
    // password on the login form itself), not a session expiry.
    throw new Error(data.message || 'Invalid email or password');
  }
  if (!res.ok) {
    throw new Error(data.message || 'Request failed');
  }
  return data;
}

const api = {
  get: (path) => apiFetch(path),
  post: (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
  put: (path, body) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: (path) => apiFetch(path, { method: 'DELETE' }),
  // Multipart upload — deliberately bypasses apiFetch's JSON content-type,
  // since the browser needs to set its own multipart boundary header.
  upload: async (path, formData) => {
    const token = localStorage.getItem('token');
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api${path}`, { method: 'POST', headers, credentials: 'include', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Upload failed');
    return data;
  },
};

/* ---------------- Theme context (light/dark) ---------------- */

const ThemeContext = createContext(null);
const useTheme = () => useContext(ThemeContext);

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button className="theme-toggle" onClick={toggleTheme} title="Toggle light/dark mode">
      {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
    </button>
  );
}

/* ---------------- Auth context ---------------- */

const AuthContext = createContext(null);
const useAuth = () => useContext(AuthContext);

function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user');
    return stored ? JSON.parse(stored) : null;
  });

  const login = async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  };

  const register = async (name, email, password, role) => {
    const data = await api.post('/auth/register', { name, email, password, role });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  };

  const logout = () => {
    api.post('/auth/logout', {}).catch(() => {}); // best-effort; clear local state regardless
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, register, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

/* ---------------- Notification context (real-time via Socket.io) ---------------- */

const NotificationContext = createContext(null);
const useNotifications = () => useContext(NotificationContext);

function NotificationProvider({ children }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [socket, setSocket] = useState(null);

  // Load notification history whenever a user logs in.
  useEffect(() => {
    if (user) {
      api.get('/notifications').then(setNotifications).catch(() => {});
    } else {
      setNotifications([]);
    }
  }, [user]);

  // Connect to Socket.io once logged in, join a private room keyed by user id,
  // and prepend any live notification that arrives while connected.
  useEffect(() => {
    if (!user || typeof io === 'undefined') return;

    const s = io();
    s.emit('join', user.id);
    s.on('notification', (n) => {
      setNotifications((prev) => [n, ...prev]);
    });
    setSocket(s);

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [user]);

  const markRead = async (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try { await api.put(`/notifications/${id}/read`, {}); } catch (e) { /* non-critical */ }
  };

  const markAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try { await api.put('/notifications/read-all', {}); } catch (e) { /* non-critical */ }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, markRead, markAllRead }}>
      {children}
    </NotificationContext.Provider>
  );
}

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function NotificationBell({ nav }) {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);

  const handleClickNotification = (n) => {
    if (!n.read) markRead(n.id);
    if (n.bug) nav('bugDetail', { id: n.bug });
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="theme-toggle" onClick={() => setOpen((o) => !o)} title="Notifications">
        🔔{unreadCount > 0 ? ` ${unreadCount}` : ''}
      </button>
      {open && (
        <div className="notification-dropdown">
          <div className="notification-dropdown-header">
            <strong>Notifications</strong>
            {unreadCount > 0 && <a onClick={markAllRead} style={{ cursor: 'pointer', fontSize: 12, color: '#22d3ee' }}>Mark all read</a>}
          </div>
          {notifications.length === 0 ? (
            <p className="activity-empty" style={{ padding: 14 }}>No notifications yet.</p>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`notification-item ${n.read ? '' : 'unread'}`}
                onClick={() => handleClickNotification(n)}
              >
                <div>{n.text}</div>
                <div className="meta">{timeAgo(n.createdAt)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Sidebar ---------------- */

const NAV_ITEMS = {
  Admin: [
    { label: 'Dashboard', view: 'dashboard' },
    { label: 'Create Project', view: 'projects', params: { autoOpenForm: true } },
    { label: 'Projects', view: 'projects' },
    { label: 'Assign Team', view: 'projects' },
    { label: 'All Bugs', view: 'bugs' },
    { label: 'Reports', view: 'reports' },
    { label: 'Users', view: 'users' },
    { label: 'My Profile', view: 'profile' },
  ],
  QA: [
    { label: 'Dashboard', view: 'dashboard' },
    { label: 'Report Bug', view: 'bugs', params: { autoOpenForm: true } },
    { label: 'Projects', view: 'projects' },
    { label: 'All Bugs', view: 'bugs' },
    { label: 'Assign Bug', view: 'bugs' },
    { label: 'Reports', view: 'reports' },
    { label: 'My Profile', view: 'profile' },
  ],
  Developer: [
    { label: 'Dashboard', view: 'dashboard' },
    { label: 'My Bugs', view: 'bugs' },
    { label: 'Projects', view: 'projects' },
    { label: 'Reports', view: 'reports' },
    { label: 'My Profile', view: 'profile' },
  ],
};

function Sidebar({ nav, view, onNavigate }) {
  const { user, logout } = useAuth();
  if (!user) return null;
  const items = NAV_ITEMS[user.role] || NAV_ITEMS.Developer;

  return (
    <div className="sidebar">
      <div>
        <div className="brand">AI BTS</div>
        <div className="brand-sub">Bug Tracking System</div>
      </div>
      <nav>
        {items.map((item) => (
          <a
            key={item.label}
            className={view === item.view ? 'active' : ''}
            onClick={() => onNavigate(item.view, item.params || {})}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <div className="user-block">
        <div className="user-name">{user.name}</div>
        <div className="user-role">{user.role}</div>
        <button className="logout-btn" onClick={logout}>Logout</button>
      </div>
    </div>
  );
}

/* ---------------- Login / First-run Setup ---------------- */

function Login({ nav }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await login(email, password);
      nav('dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-box">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -8 }}>
          <ThemeToggle />
        </div>
        <h2>Welcome back</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
        <div className="link-text">
          No account? Ask your Admin to create one for you from the Users page.
        </div>
      </div>
    </div>
  );
}

// Shown only once, when the database has zero users — creates the first Admin account.
// There is no ongoing public registration after this; every other account is created
// by an Admin from the Users management page.
function Setup({ nav }) {
  const { register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await register(form.name, form.email, form.password, 'Admin');
      nav('dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-box">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -8 }}>
          <ThemeToggle />
        </div>
        <h2>Welcome — let's set things up</h2>
        <p style={{ color: '#94a3b8', fontSize: 13, marginTop: -8, marginBottom: 18 }}>
          This looks like a fresh install. Create the first Admin account to get started —
          you'll be able to add QA and Developer accounts afterward from the Users page.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name</label>
            <input name="name" value={form.name} onChange={handleChange} required />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input type="email" name="email" value={form.email} onChange={handleChange} required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" name="password" value={form.password} onChange={handleChange} required minLength={6} />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Creating account...' : 'Create Admin Account'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */

const STAT_LABELS = {
  Admin: [
    { key: 'totalProjects', label: 'Total Projects' },
    { key: 'totalBugs', label: 'Total Bugs' },
    { key: 'open', label: 'Open Bugs', tone: 'orange' },
    { key: 'inProgress', label: 'In Progress Bugs' },
    { key: 'closed', label: 'Closed Bugs', tone: 'green' },
  ],
  QA: [
    { key: 'created', label: 'Created Bugs' },
    { key: 'open', label: 'Open Bugs', tone: 'orange' },
    { key: 'reopened', label: 'Reopened Bugs' },
    { key: 'closed', label: 'Closed Bugs', tone: 'green' },
  ],
  Developer: [
    { key: 'assigned', label: 'Assigned Bugs' },
    { key: 'inProgress', label: 'In Progress Bugs' },
    { key: 'readyForTesting', label: 'Ready For Testing Bugs' },
  ],
};

const ACTION_TEXT = {
  'Bug Created': (a) => `Bug ${a.bugId} created`,
  'Bug Assigned to Developer': (a) => `Bug ${a.bugId} assigned to a developer`,
  'Bug Details Updated': (a) => `Bug ${a.bugId} details updated`,
};

function describeActivity(a) {
  if (ACTION_TEXT[a.action]) return ACTION_TEXT[a.action](a);
  if (a.action?.startsWith('Status changed to')) {
    const status = a.action.replace('Status changed to ', '');
    return `Bug ${a.bugId} marked as ${status}`;
  }
  return `${a.bugId ? `Bug ${a.bugId}: ` : ''}${a.action}`;
}

function Dashboard({ nav }) {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState(null);

  useEffect(() => {
    api.get('/bugs/dashboard/stats').then(setStats);
    api.get('/bugs/dashboard/recent-activity').then(setActivity);
  }, []);

  const labels = STAT_LABELS[user.role] || [];

  return (
    <div className="container">
      <div className="welcome-card">
        <h2>Welcome, {user.name} 👋</h2>
        <p className="subtitle">Manage projects, bugs and team activities.</p>
        <div className="actions">
          <span className="role-badge">Role: {user.role}</span>
          {user.role === 'Admin' && (
            <button className="btn-cyan" onClick={() => nav('projects', { autoOpenForm: true })}>Create Project</button>
          )}
          {user.role === 'QA' && (
            <button className="btn-cyan" onClick={() => nav('bugs', { autoOpenForm: true })}>Report Bug</button>
          )}
        </div>
      </div>

      {!stats ? <p>Loading stats...</p> : (
        <div className="grid-stats">
          {labels.map((l) => (
            <div className={`stat-box ${l.tone ? 'tone-' + l.tone : ''}`} key={l.key}>
              <div className="value">{stats[l.key] ?? 0}</div>
              <div className="label">{l.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="activity-card">
        <h3>Recent Activity</h3>
        {!activity ? (
          <p className="activity-empty">Loading...</p>
        ) : activity.length === 0 ? (
          <p className="activity-empty">No activity yet.</p>
        ) : (
          activity.map((a) => (
            <div className="activity-item" key={a.id}>
              <span className="activity-check">✅</span>
              <div>
                <div>{describeActivity(a)}</div>
                <div className="meta">{a.userName} &middot; {new Date(a.timestamp).toLocaleString()}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------- Projects (master-detail + Kanban) ---------------- */

const emptyProjectForm = { name: '', description: '', startDate: '', endDate: '', qaMembers: [], developers: [] };

const KANBAN_COLUMNS = ['Open', 'In Progress', 'Ready For Testing', 'Reopened', 'Closed'];

function Projects({ nav, params }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [qaUsers, setQaUsers] = useState([]);
  const [devUsers, setDevUsers] = useState([]);
  const [showForm, setShowForm] = useState(!!(params && params.autoOpenForm));
  const [form, setForm] = useState(emptyProjectForm);
  const [error, setError] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectBugs, setProjectBugs] = useState([]);
  const [teamForm, setTeamForm] = useState({ qaMembers: [], developers: [] });
  const [teamSaving, setTeamSaving] = useState(false);
  const [teamMsg, setTeamMsg] = useState('');

  const loadProjects = () => api.get('/projects').then(setProjects);

  useEffect(() => {
    loadProjects();
    if (user.role === 'Admin') {
      api.get('/auth/users?role=QA').then(setQaUsers);
      api.get('/auth/users?role=Developer').then(setDevUsers);
    }
  }, [user.role]);

  useEffect(() => {
    if (params && params.autoOpenForm) setShowForm(true);
  }, [params]);

  const loadSelected = useCallback((id) => {
    if (!id) return;
    api.get(`/projects/${id}`).then((p) => {
      setSelectedProject(p);
      setTeamForm({
        qaMembers: (p.qaMembers || []).map((u) => u.id),
        developers: (p.developers || []).map((u) => u.id),
      });
    });
    api.get(`/bugs?project=${id}`).then(setProjectBugs);
  }, []);

  useEffect(() => {
    if (selectedId) loadSelected(selectedId);
  }, [selectedId, loadSelected]);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });
  const handleMultiSelect = (e, field) => {
    const options = Array.from(e.target.selectedOptions).map((o) => o.value);
    setForm({ ...form, [field]: options });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const created = await api.post('/projects', form);
      setForm(emptyProjectForm);
      setShowForm(false);
      await loadProjects();
      setSelectedId(created.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTeamMultiSelect = (e, field) => {
    const options = Array.from(e.target.selectedOptions).map((o) => o.value);
    setTeamForm({ ...teamForm, [field]: options });
  };

  const handleSaveTeam = async () => {
    setTeamSaving(true); setTeamMsg('');
    try {
      await api.put(`/projects/${selectedId}`, teamForm);
      setTeamMsg('Team updated.');
      loadSelected(selectedId);
      loadProjects();
    } catch (err) {
      setTeamMsg(err.message);
    } finally {
      setTeamSaving(false);
    }
  };

  const bugsByStatus = (status) => projectBugs.filter((b) => b.status === status);

  return (
    <div className="container">
      <div className="flex-between">
        <h2>Projects</h2>
        {user.role === 'Admin' && (
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : '+ New Project'}
          </button>
        )}
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Project Name</label>
              <input name="name" value={form.name} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea name="description" value={form.description} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>Start Date</label>
              <input type="date" name="startDate" value={form.startDate} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>End Date</label>
              <input type="date" name="endDate" value={form.endDate} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>QA Members (ctrl/cmd+click to select multiple)</label>
              <select multiple value={form.qaMembers} onChange={(e) => handleMultiSelect(e, 'qaMembers')}>
                {qaUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Developers (ctrl/cmd+click to select multiple)</label>
              <select multiple value={form.developers} onChange={(e) => handleMultiSelect(e, 'developers')}>
                {devUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
              </select>
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary">Create Project</button>
          </form>
        </div>
      )}

      <div className="projects-master-detail">
        <div className="projects-list-panel">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-list-item ${selectedId === p.id ? 'active' : ''}`}
              onClick={() => setSelectedId(p.id)}
            >
              <div className="project-list-item-name">{p.name}</div>
              <div className="project-list-item-meta">
                {p.status} &middot; {(p.qaMembers?.length || 0)} QA / {(p.developers?.length || 0)} Dev
              </div>
            </div>
          ))}
          {projects.length === 0 && <p className="activity-empty">No projects yet.</p>}
        </div>

        <div className="projects-detail-panel">
          {!selectedProject ? (
            <div className="card"><p className="activity-empty">Select a project on the left to view its details.</p></div>
          ) : (
            <>
              <div className="card">
                <div className="flex-between">
                  <h3 style={{ margin: 0 }}>{selectedProject.name}</h3>
                  {user.role === 'QA' && (
                    <button className="btn btn-primary btn-sm" onClick={() => nav('bugs', { autoOpenForm: true, project: selectedId })}>
                      + Create Bug
                    </button>
                  )}
                </div>
                <p>{selectedProject.description}</p>
                <p><strong>Status:</strong> {selectedProject.status}</p>
                <p><strong>Start:</strong> {selectedProject.startDate ? new Date(selectedProject.startDate).toLocaleDateString() : '-'} &nbsp;
                   <strong>End:</strong> {selectedProject.endDate ? new Date(selectedProject.endDate).toLocaleDateString() : '-'}</p>

                {user.role === 'Admin' ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="form-group">
                      <label>QA Members</label>
                      <select multiple value={teamForm.qaMembers} onChange={(e) => handleTeamMultiSelect(e, 'qaMembers')}>
                        {qaUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Developers</label>
                      <select multiple value={teamForm.developers} onChange={(e) => handleTeamMultiSelect(e, 'developers')}>
                        {devUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                      </select>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={handleSaveTeam} disabled={teamSaving}>
                      {teamSaving ? 'Saving...' : 'Save Team'}
                    </button>
                    {teamMsg && <span style={{ marginLeft: 10, fontSize: 13, color: '#94a3b8' }}>{teamMsg}</span>}
                  </div>
                ) : (
                  <>
                    <p><strong>QA Members:</strong> {selectedProject.qaMembers?.map((u) => u.name).join(', ') || 'None'}</p>
                    <p><strong>Developers:</strong> {selectedProject.developers?.map((u) => u.name).join(', ') || 'None'}</p>
                  </>
                )}
              </div>

              <h3>Bugs — Kanban Board</h3>
              <div className="kanban-board">
                {KANBAN_COLUMNS.map((col) => (
                  <div className="kanban-column" key={col}>
                    <h5>{col} ({bugsByStatus(col).length})</h5>
                    {bugsByStatus(col).map((b) => (
                      <div className="kanban-card" key={b.id} onClick={() => nav('bugDetail', { id: b.id })}>
                        <div className="bug-id">{b.bugId}</div>
                        <div>{b.title}</div>
                        <div style={{ marginTop: 6 }}>
                          <span className={`badge badge-${b.severity}`}>{b.severity}</span>
                        </div>
                        {b.assignedDeveloper && (
                          <div style={{ marginTop: 6, fontSize: 12, color: '#94a3b8' }}>👤 {b.assignedDeveloper.name}</div>
                        )}
                      </div>
                    ))}
                    {bugsByStatus(col).length === 0 && <p className="activity-empty" style={{ fontSize: 12 }}>None</p>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Bugs ---------------- */

const emptyBugForm = {
  title: '', description: '', stepsToReproduce: '', expectedResult: '', actualResult: '',
  project: '', module: '', environment: 'Development', severity: 'Medium', priority: 'Medium',
};

function Bugs({ nav, params }) {
  const { user } = useAuth();
  const [bugs, setBugs] = useState([]);
  const [projects, setProjects] = useState([]);
  const [filters, setFilters] = useState({ project: '', status: '', severity: '', priority: '', search: '' });
  const [showForm, setShowForm] = useState(!!(params && params.autoOpenForm));
  const [form, setForm] = useState(emptyBugForm);
  const [descLoading, setDescLoading] = useState(false);
  const [predictLoading, setPredictLoading] = useState(false);
  const [severityReason, setSeverityReason] = useState('');
  const [priorityReason, setPriorityReason] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState('');
  const [dupLoading, setDupLoading] = useState(false);
  const [dupResult, setDupResult] = useState(null);
  const [error, setError] = useState('');

  const loadBugs = useCallback(() => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    api.get(`/bugs?${params.toString()}`).then(setBugs);
  }, [filters]);

  useEffect(() => { loadBugs(); }, [loadBugs]);
  useEffect(() => { api.get('/projects').then(setProjects); }, []);
  useEffect(() => {
    if (params && params.autoOpenForm) setShowForm(true);
    if (params && params.project) setForm((f) => ({ ...f, project: params.project }));
  }, [params]);

  const handleFilterChange = (e) => setFilters({ ...filters, [e.target.name]: e.target.value });
  const handleFormChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const stepsArray = () => form.stepsToReproduce.split('\n').map((s) => s.trim()).filter(Boolean);

  // Step 1: AI Bug Description Generator (Title + Steps -> Description/Expected/Actual)
  const handleGenerateDescription = async () => {
    if (!form.project || !form.title || stepsArray().length === 0) {
      setError('Select a project, enter a title, and add at least one step to reproduce first.');
      return;
    }
    setDescLoading(true); setError('');
    try {
      const result = await api.post('/ai/generate-description', {
        projectId: form.project,
        title: form.title,
        stepsToReproduce: stepsArray(),
      });
      setForm((f) => ({
        ...f,
        description: result.description || f.description,
        expectedResult: result.expectedResult || f.expectedResult,
        actualResult: result.actualResult || f.actualResult,
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setDescLoading(false);
    }
  };

  // Step 2: AI Severity + Priority Prediction
  const handlePredict = async () => {
    if (!form.project || !form.title || !form.description) {
      setError('Generate (or write) a description first before predicting severity/priority.');
      return;
    }
    setPredictLoading(true); setError('');
    try {
      const result = await api.post('/ai/predict-severity-priority', {
        projectId: form.project,
        title: form.title,
        description: form.description,
      });
      setForm((f) => ({ ...f, severity: result.severity || f.severity, priority: result.priority || f.priority }));
      setSeverityReason(result.severityReason || '');
      setPriorityReason(result.priorityReason || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setPredictLoading(false);
    }
  };

  // AI Bug Summary — condense the (possibly manually-written) description into one clean sentence
  const handleGenerateSummary = async () => {
    if (!form.project || !form.description) {
      setError('Select a project and enter a description first to summarize it.');
      return;
    }
    setSummaryLoading(true); setError('');
    try {
      const result = await api.post('/ai/generate-summary', {
        projectId: form.project,
        description: form.description,
      });
      setAiSummary(result.summary || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setSummaryLoading(false);
    }
  };

  // Duplicate Bug Detection — compare against existing bugs in the same project
  const handleCheckDuplicate = async () => {
    if (!form.project || !form.title || !form.description) {
      setError('Select a project, enter a title and description first to check for duplicates.');
      return;
    }
    setDupLoading(true); setError(''); setDupResult(null);
    try {
      const result = await api.post('/ai/detect-duplicate', {
        projectId: form.project,
        title: form.title,
        description: form.description,
      });
      setDupResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setDupLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const payload = {
        ...form,
        stepsToReproduce: stepsArray(),
        aiSeverityReason: severityReason,
        aiPriorityReason: priorityReason,
        aiSummary,
      };
      await api.post('/bugs', payload);
      setForm(emptyBugForm);
      setSeverityReason(''); setPriorityReason(''); setAiSummary(''); setDupResult(null);
      setShowForm(false);
      loadBugs();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="container">
      <div className="flex-between">
        <h2>Bugs</h2>
        {user.role === 'QA' && (
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : '+ Report Bug'}
          </button>
        )}
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Project</label>
              <select name="project" value={form.project} onChange={handleFormChange} required>
                <option value="">Select project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Title</label>
              <input name="title" value={form.title} onChange={handleFormChange} required />
            </div>

            <button type="button" className="btn btn-ai" onClick={handleCheckDuplicate} disabled={dupLoading}>
              {dupLoading ? 'Checking with Gemini...' : '🔍 Check for Duplicates (AI)'}
            </button>

            {dupResult && (
              <div className="ai-box" style={{ marginTop: 10 }}>
                {dupResult.isDuplicate ? (
                  <>
                    <h4>⚠️ Possible Duplicate</h4>
                    <p>Possible duplicate of <strong>{dupResult.duplicateBugId}</strong>: "{dupResult.duplicateTitle}"</p>
                    <p style={{ color: '#94a3b8', fontSize: 13 }}>{dupResult.reason}</p>
                  </>
                ) : (
                  <p style={{ color: '#4ade80' }}>✓ No likely duplicate found. {dupResult.reason}</p>
                )}
              </div>
            )}

            <div className="form-group" style={{ marginTop: 14 }}>
              <label>Steps to Reproduce (one per line)</label>
              <textarea
                name="stepsToReproduce"
                value={form.stepsToReproduce}
                onChange={handleFormChange}
                placeholder={'Open Login page\nEnter valid credentials\nClick Login'}
                required
              />
            </div>

            <button type="button" className="btn btn-ai" onClick={handleGenerateDescription} disabled={descLoading}>
              {descLoading ? 'Generating with Gemini...' : '✨ Generate Description (AI)'}
            </button>

            <div style={{ marginTop: 14 }}>
              <div className="form-group">
                <label>Description</label>
                <textarea name="description" value={form.description} onChange={handleFormChange} required />
              </div>

              <button type="button" className="btn btn-ai" onClick={handleGenerateSummary} disabled={summaryLoading}>
                {summaryLoading ? 'Summarizing with Gemini...' : '📝 Generate Summary (AI)'}
              </button>
              {aiSummary && (
                <div className="ai-box" style={{ marginTop: 10 }}>
                  <p><strong>AI Summary:</strong> {aiSummary}</p>
                </div>
              )}

              <div className="form-group" style={{ marginTop: 14 }}>
                <label>Expected Result</label>
                <textarea name="expectedResult" value={form.expectedResult} onChange={handleFormChange} />
              </div>
              <div className="form-group">
                <label>Actual Result</label>
                <textarea name="actualResult" value={form.actualResult} onChange={handleFormChange} />
              </div>
            </div>

            <div className="form-group">
              <label>Module</label>
              <input name="module" value={form.module} onChange={handleFormChange} />
            </div>
            <div className="form-group">
              <label>Environment</label>
              <select name="environment" value={form.environment} onChange={handleFormChange}>
                <option>Development</option><option>QA</option><option>UAT</option><option>Production</option>
              </select>
            </div>

            <button type="button" className="btn btn-ai" onClick={handlePredict} disabled={predictLoading}>
              {predictLoading ? 'Predicting with Gemini...' : '🎯 Predict Severity & Priority (AI)'}
            </button>

            <div style={{ marginTop: 14, display: 'flex', gap: 14 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Severity</label>
                <select name="severity" value={form.severity} onChange={handleFormChange}>
                  <option>Low</option><option>Medium</option><option>High</option><option>Critical</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Priority</label>
                <select name="priority" value={form.priority} onChange={handleFormChange}>
                  <option>Low</option><option>Medium</option><option>High</option><option>Critical</option>
                </select>
              </div>
            </div>

            {(severityReason || priorityReason) && (
              <div className="ai-box">
                <h4>AI Reasoning</h4>
                {severityReason && <p><strong>Severity:</strong> {severityReason}</p>}
                {priorityReason && <p><strong>Priority:</strong> {priorityReason}</p>}
              </div>
            )}

            {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary">Create Bug</button>
            </div>
          </form>
        </div>
      )}

      <div className="filters">
        <input name="search" placeholder="Search by title or Bug ID" value={filters.search} onChange={handleFilterChange} />
        <select name="project" value={filters.project} onChange={handleFilterChange}>
          <option value="">All Projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select name="status" value={filters.status} onChange={handleFilterChange}>
          <option value="">All Statuses</option>
          <option>Open</option><option>In Progress</option><option>Ready For Testing</option><option>Closed</option><option>Reopened</option>
        </select>
        <select name="severity" value={filters.severity} onChange={handleFilterChange}>
          <option value="">All Severities</option>
          <option>Low</option><option>Medium</option><option>High</option><option>Critical</option>
        </select>
        <select name="priority" value={filters.priority} onChange={handleFilterChange}>
          <option value="">All Priorities</option>
          <option>Low</option><option>Medium</option><option>High</option><option>Critical</option>
        </select>
      </div>

      <table>
        <thead>
          <tr><th>Bug ID</th><th>Title</th><th>Project</th><th>Severity</th><th>Priority</th><th>Status</th><th>Developer</th><th></th></tr>
        </thead>
        <tbody>
          {bugs.map((b) => (
            <tr key={b.id}>
              <td>{b.bugId}</td>
              <td>{b.title}</td>
              <td>{b.project?.name}</td>
              <td><span className={`badge badge-${b.severity}`}>{b.severity}</span></td>
              <td><span className={`badge badge-${b.priority}`}>{b.priority}</span></td>
              <td><span className={`badge badge-${b.status.replace(/ /g, '-')}`}>{b.status}</span></td>
              <td>{b.assignedDeveloper?.name || '-'}</td>
              <td><button className="btn btn-secondary btn-sm" onClick={() => nav('bugDetail', { id: b.id })}>View</button></td>
            </tr>
          ))}
          {bugs.length === 0 && <tr><td colSpan={8}>No bugs found.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const ALLOWED_TRANSITIONS = {
  Open: ['In Progress'],
  'In Progress': ['Ready For Testing'],
  'Ready For Testing': ['Closed', 'Reopened'],
  Reopened: ['In Progress'],
  Closed: [],
};

function BugDetail({ nav, params }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [devUsers, setDevUsers] = useState([]);
  const [selectedDev, setSelectedDev] = useState('');
  const [error, setError] = useState('');
  const [testCasesLoading, setTestCasesLoading] = useState(false);
  const [fixLoading, setFixLoading] = useState(false);
  const [rootCauseLoading, setRootCauseLoading] = useState(false);
  const [chatQuestion, setChatQuestion] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [commentLoading, setCommentLoading] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replyLoading, setReplyLoading] = useState(false);

  const load = useCallback(() => {
    api.get(`/bugs/${params.id}`).then(setData);
  }, [params.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (user.role === 'QA') api.get('/auth/users?role=Developer').then(setDevUsers);
  }, [user.role]);

  const handleAssign = async () => {
    if (!selectedDev) return;
    setError('');
    try {
      await api.put(`/bugs/${params.id}/assign`, { developerId: selectedDev });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleStatusChange = async (status) => {
    setError('');
    try {
      await api.put(`/bugs/${params.id}/status`, { status });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handlePostComment = async (e) => {
    e.preventDefault();
    if (!newComment.trim()) return;
    setCommentLoading(true); setError('');
    try {
      await api.post(`/bugs/${params.id}/comments`, { text: newComment.trim() });
      setNewComment('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCommentLoading(false);
    }
  };

  const handlePostReply = async (commentId) => {
    if (!replyText.trim()) return;
    setReplyLoading(true); setError('');
    try {
      await api.post(`/comments/${commentId}/replies`, { text: replyText.trim() });
      setReplyText('');
      setReplyingTo(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setReplyLoading(false);
    }
  };

  const handleDeleteComment = async (commentId) => {
    try {
      await api.del(`/comments/${commentId}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUploadAttachments = async () => {
    if (selectedFiles.length === 0) return;
    setUploadLoading(true); setError('');
    try {
      const formData = new FormData();
      selectedFiles.forEach((f) => formData.append('files', f));
      await api.upload(`/bugs/${params.id}/attachments`, formData);
      setSelectedFiles([]);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadLoading(false);
    }
  };

  const handleDeleteAttachment = async (attachmentId) => {
    try {
      await api.del(`/bugs/${params.id}/attachments/${attachmentId}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  // 5. AI Test Cases Generator (QA)
  const handleGenerateTestCases = async () => {
    setTestCasesLoading(true); setError('');
    try {
      await api.post(`/ai/bugs/${params.id}/test-cases`, {});
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setTestCasesLoading(false);
    }
  };

  // 4. AI Fix Suggestion (Developer)
  const handleSuggestFix = async () => {
    setFixLoading(true); setError('');
    try {
      await api.post(`/ai/bugs/${params.id}/fix-suggestion`, {});
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setFixLoading(false);
    }
  };

  // 6. AI Root Cause Analysis (Developer)
  const handleAnalyzeRootCause = async () => {
    setRootCauseLoading(true); setError('');
    try {
      await api.post(`/ai/bugs/${params.id}/root-cause`, {});
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRootCauseLoading(false);
    }
  };

  // 9. AI Chat Assistant — ask a free-form question about this bug
  const handleAskAI = async (e) => {
    e.preventDefault();
    if (!chatQuestion.trim()) return;
    const question = chatQuestion.trim();
    setChatLoading(true); setError('');
    try {
      const result = await api.post(`/ai/bugs/${params.id}/ask`, { question });
      setChatHistory((h) => [...h, { question, answer: result.answer }]);
      setChatQuestion('');
    } catch (err) {
      setError(err.message);
    } finally {
      setChatLoading(false);
    }
  };

  if (!data) return <div className="container">Loading...</div>;
  const { bug, history, comments } = data;
  const nextStatuses = ALLOWED_TRANSITIONS[bug.status] || [];
  const canTransition = user.role === 'QA' || user.role === 'Developer';

  return (
    <div className="container">
      <a onClick={() => nav('bugs')} style={{ cursor: 'pointer', color: '#2563eb' }}>&larr; Back to Bugs</a>
      <div className="flex-between">
        <h2>{bug.bugId}: {bug.title}</h2>
        <span className={`badge badge-${bug.status.replace(/ /g, '-')}`}>{bug.status}</span>
      </div>

      <div className="card">
        <p><strong>Project:</strong> {bug.project?.name}</p>
        <p><strong>Description:</strong> {bug.description}</p>
        {bug.aiSummary && <p><strong>AI Summary:</strong> {bug.aiSummary}</p>}
        {bug.stepsToReproduce?.length > 0 && (
          <>
            <p><strong>Steps to Reproduce:</strong></p>
            <ol>{bug.stepsToReproduce.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </>
        )}
        {bug.expectedResult && <p><strong>Expected Result:</strong> {bug.expectedResult}</p>}
        {bug.actualResult && <p><strong>Actual Result:</strong> {bug.actualResult}</p>}
        <p>
          <span className={`badge badge-${bug.severity}`}>{bug.severity}</span>{' '}
          <span className={`badge badge-${bug.priority}`}>{bug.priority}</span>{' '}
          <span className="badge" style={{ background: '#1e293b', color: '#cbd5e1' }}>{bug.environment}</span>
        </p>
        {(bug.aiSeverityReason || bug.aiPriorityReason) && (
          <p style={{ fontSize: 13, color: '#94a3b8' }}>
            {bug.aiSeverityReason && <>🎯 <strong>Severity reason:</strong> {bug.aiSeverityReason}<br /></>}
            {bug.aiPriorityReason && <>🎯 <strong>Priority reason:</strong> {bug.aiPriorityReason}</>}
          </p>
        )}
        <p><strong>Assigned Developer:</strong> {bug.assignedDeveloper?.name || 'Unassigned'}</p>
        <p><strong>Created By:</strong> {bug.createdBy?.name}</p>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <h4>📎 Attachments</h4>
        {bug.attachments?.length > 0 && (
          <div className="attachment-list">
            {bug.attachments.map((a) => (
              <div className="attachment-item" key={a._id || a.filepath}>
                <a href={a.filepath} target="_blank" rel="noopener noreferrer">{a.filename}</a>
                <span className="meta">
                  {new Date(a.uploadedAt).toLocaleDateString()}
                  {' '}
                  <a onClick={() => handleDeleteAttachment(a._id)} style={{ cursor: 'pointer', color: '#f87171', marginLeft: 8 }}>Remove</a>
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="file"
            multiple
            onChange={(e) => setSelectedFiles(Array.from(e.target.files))}
            style={{ fontSize: 13, color: 'var(--text-secondary)' }}
          />
          <button className="btn btn-secondary btn-sm" onClick={handleUploadAttachments} disabled={uploadLoading || selectedFiles.length === 0}>
            {uploadLoading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
          Images, PDFs, text/log files, CSVs, zips — up to 10MB each, 5 files per upload.
        </p>
      </div>

      {user.role === 'QA' && (
        <div className="card">
          <h4>Assign Developer</h4>
          <div style={{ display: 'flex', gap: 10 }}>
            <select value={selectedDev} onChange={(e) => setSelectedDev(e.target.value)} style={{ flex: 1 }}>
              <option value="">Select developer</option>
              {devUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="btn btn-primary" onClick={handleAssign}>Assign</button>
          </div>
        </div>
      )}

      {canTransition && nextStatuses.length > 0 && (
        <div className="card">
          <h4>Update Status</h4>
          <div style={{ display: 'flex', gap: 10 }}>
            {nextStatuses.map((s) => (
              <button key={s} className="btn btn-secondary" onClick={() => handleStatusChange(s)}>
                Move to "{s}"
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 5. AI Test Cases Generator — QA */}
      {user.role === 'QA' && (
        <div className="card">
          <div className="flex-between">
            <h4 style={{ margin: 0 }}>🧪 AI Test Cases</h4>
            <button className="btn btn-ai btn-sm" onClick={handleGenerateTestCases} disabled={testCasesLoading}>
              {testCasesLoading ? 'Generating...' : bug.testCases ? 'Regenerate' : 'Generate Test Cases'}
            </button>
          </div>
          {bug.testCases && (
            <div className="ai-box" style={{ marginTop: 12 }}>
              <p><strong>Positive Cases</strong></p>
              <ul>{bug.testCases.positive?.map((t, i) => <li key={i}>{t}</li>)}</ul>
              <p><strong>Negative Cases</strong></p>
              <ul>{bug.testCases.negative?.map((t, i) => <li key={i}>{t}</li>)}</ul>
              <p><strong>Boundary Cases</strong></p>
              <ul>{bug.testCases.boundary?.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* 4. AI Fix Suggestion — Developer and QA (backend already allows both) */}
      {(user.role === 'Developer' || user.role === 'QA') && (
        <div className="card">
          <div className="flex-between">
            <h4 style={{ margin: 0 }}>🔧 AI Fix Suggestion</h4>
            <button className="btn btn-ai btn-sm" onClick={handleSuggestFix} disabled={fixLoading}>
              {fixLoading ? 'Generating...' : bug.fixSuggestion ? 'Regenerate' : 'Suggest Fix'}
            </button>
          </div>
          {bug.fixSuggestion && (
            <div className="ai-box" style={{ marginTop: 12 }}>
              <p><strong>Possible Causes:</strong></p>
              <ul>{(bug.fixSuggestion.possibleCauses || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
              <p><strong>Possible Fix:</strong> {bug.fixSuggestion.possibleFix}</p>
              {bug.fixSuggestion.filesToCheck?.length > 0 && (
                <>
                  <p><strong>Files to Check:</strong></p>
                  <ul>{bug.fixSuggestion.filesToCheck.map((f, i) => <li key={i}>{f}</li>)}</ul>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* 6. AI Root Cause Analysis — Developer */}
      {user.role === 'Developer' && (
        <div className="card">
          <div className="flex-between">
            <h4 style={{ margin: 0 }}>🔍 AI Root Cause Analysis</h4>
            <button className="btn btn-ai btn-sm" onClick={handleAnalyzeRootCause} disabled={rootCauseLoading}>
              {rootCauseLoading ? 'Analyzing...' : bug.rootCauseAnalysis ? 'Re-analyze' : 'Analyze Bug'}
            </button>
          </div>
          {bug.rootCauseAnalysis && (
            <div className="ai-box" style={{ marginTop: 12 }}>
              <p><strong>Root Cause:</strong> {bug.rootCauseAnalysis.rootCause}</p>
              {bug.rootCauseAnalysis.affectedModules?.length > 0 && (
                <>
                  <p><strong>Affected Modules:</strong></p>
                  <ul>{bug.rootCauseAnalysis.affectedModules.map((m, i) => <li key={i}>{m}</li>)}</ul>
                </>
              )}
              <p><strong>Risk Level:</strong> {bug.rootCauseAnalysis.riskLevel}</p>
            </div>
          )}
        </div>
      )}

      {/* 9. AI Chat Assistant — everyone */}
      <div className="card">
        <h4>💬 Ask AI about this bug</h4>
        {chatHistory.map((entry, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 4px' }}>Q: {entry.question}</p>
            <div className="ai-box">{entry.answer}</div>
          </div>
        ))}
        <form onSubmit={handleAskAI} style={{ display: 'flex', gap: 10 }}>
          <input
            type="text"
            placeholder='e.g. "Why is this bug marked Critical?"'
            value={chatQuestion}
            onChange={(e) => setChatQuestion(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn btn-ai btn-sm" disabled={chatLoading}>
            {chatLoading ? 'Asking...' : 'Ask'}
          </button>
        </form>
      </div>

      <div className="card">
        <h4>🗨️ Comments</h4>
        {comments.filter((c) => !c.parentComment).length === 0 && (
          <p className="activity-empty">No comments yet — start the discussion.</p>
        )}
        {comments.filter((c) => !c.parentComment).map((c) => (
          <div key={c.id} className="comment-thread">
            <div className="comment-item">
              <div className="comment-header">
                <strong>{c.user?.name}</strong>
                <span className="meta">{timeAgo(c.createdAt)}</span>
                {(c.user?.id === user.id || user.role === 'Admin') && (
                  <a onClick={() => handleDeleteComment(c.id)} style={{ cursor: 'pointer', color: '#f87171', marginLeft: 8, fontSize: 12 }}>Delete</a>
                )}
              </div>
              <div>{c.text}</div>
              <a onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)} style={{ cursor: 'pointer', color: '#22d3ee', fontSize: 12 }}>
                {replyingTo === c.id ? 'Cancel' : 'Reply'}
              </a>
            </div>

            {comments.filter((r) => r.parentComment === c.id).map((r) => (
              <div key={r.id} className="comment-item comment-reply">
                <div className="comment-header">
                  <strong>{r.user?.name}</strong>
                  <span className="meta">{timeAgo(r.createdAt)}</span>
                  {(r.user?.id === user.id || user.role === 'Admin') && (
                    <a onClick={() => handleDeleteComment(r.id)} style={{ cursor: 'pointer', color: '#f87171', marginLeft: 8, fontSize: 12 }}>Delete</a>
                  )}
                </div>
                <div>{r.text}</div>
              </div>
            ))}

            {replyingTo === c.id && (
              <div className="comment-reply" style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Write a reply..."
                  style={{ flex: 1 }}
                />
                <button className="btn btn-secondary btn-sm" onClick={() => handlePostReply(c.id)} disabled={replyLoading}>
                  {replyLoading ? 'Posting...' : 'Post'}
                </button>
              </div>
            )}
          </div>
        ))}

        <form onSubmit={handlePostComment} style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <input
            type="text"
            placeholder="Add a comment..."
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary btn-sm" disabled={commentLoading}>
            {commentLoading ? 'Posting...' : 'Post'}
          </button>
        </form>
      </div>

      <div className="card">
        <h4>History</h4>
        {history.map((h) => (
          <div className="history-item" key={h.id}>
            <div>{h.action} — {h.user?.name} ({h.user?.role})</div>
            <div className="time">{new Date(h.timestamp).toLocaleString()}</div>
          </div>
        ))}
        {history.length === 0 && <p>No history yet.</p>}
      </div>
    </div>

  );
}

/* ---------------- Users (Admin only) ---------------- */

const emptyUserForm = { name: '', email: '', password: '', role: 'QA' };

function Users() {
  const [users, setUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyUserForm);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadUsers = () => api.get('/auth/users').then(setUsers);
  useEffect(() => { loadUsers(); }, []);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      // Calling the API directly (not AuthContext.register) so this does NOT
      // replace the currently logged-in Admin's session with the new user's.
      await api.post('/auth/register', form);
      setForm(emptyUserForm);
      setShowForm(false);
      loadUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <div className="flex-between">
        <h2>Users</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ Add User'}
        </button>
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Name</label>
              <input name="name" value={form.name} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" name="email" value={form.email} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input type="password" name="password" value={form.password} onChange={handleChange} required minLength={6} />
            </div>
            <div className="form-group">
              <label>Role</label>
              <select name="role" value={form.role} onChange={handleChange}>
                <option value="Admin">Admin</option>
                <option value="QA">QA (Tester)</option>
                <option value="Developer">Developer</option>
              </select>
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary" disabled={loading}>{loading ? 'Creating...' : 'Create User'}</button>
          </form>
        </div>
      )}

      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td><span className="badge" style={{ background: '#1e293b', color: '#cbd5e1' }}>{u.role}</span></td>
            </tr>
          ))}
          {users.length === 0 && <tr><td colSpan={3}>No users yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Profile ---------------- */

function Profile() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');

    if (newPassword && newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }

    setLoading(true);
    try {
      const payload = { name };
      if (newPassword) {
        payload.currentPassword = currentPassword;
        payload.newPassword = newPassword;
      }
      const updated = await api.put('/auth/profile', payload);
      localStorage.setItem('user', JSON.stringify(updated));
      if (setUser) setUser(updated);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setSuccess('Profile updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <h2>My Profile</h2>
      <div className="card" style={{ maxWidth: 480 }}>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input value={user.email} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="form-group">
            <label>Role</label>
            <input value={user.role} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="form-group">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <h4 style={{ marginTop: 20, marginBottom: 10 }}>Change Password (optional)</h4>
          <div className="form-group">
            <label>Current Password</label>
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Required only if setting a new password" />
          </div>
          <div className="form-group">
            <label>New Password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} />
          </div>
          <div className="form-group">
            <label>Confirm New Password</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={6} />
          </div>

          {error && <div className="error-text">{error}</div>}
          {success && <p style={{ color: '#4ade80', fontSize: 13, marginTop: -6, marginBottom: 12 }}>{success}</p>}
          <button className="btn btn-primary" disabled={loading}>{loading ? 'Saving...' : 'Save Changes'}</button>
        </form>
      </div>
    </div>
  );
}

/* ---------------- Reports (custom SVG charts, no external library) ---------------- */

const STATUS_COLORS = {
  Open: '#f87171',
  'In Progress': '#fcd34d',
  'Ready For Testing': '#93c5fd',
  Closed: '#86efac',
  Reopened: '#d8b4fe',
};
const SEVERITY_COLORS = { Low: '#94a3b8', Medium: '#fcd34d', High: '#fdba74', Critical: '#f87171' };

function DonutChart({ data, colors, size = 180 }) {
  const total = Object.values(data).reduce((a, b) => a + b, 0);
  const radius = size / 2 - 14;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  if (total === 0) {
    return <p className="activity-empty">No data yet.</p>;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {Object.entries(data).map(([label, value]) => {
            if (value === 0) return null;
            const fraction = value / total;
            const dash = fraction * circumference;
            const el = (
              <circle
                key={label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={colors[label] || '#64748b'}
                strokeWidth={20}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return el;
          })}
        </g>
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fontSize="22" fontWeight="800" fill="var(--text-primary)">
          {total}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {Object.entries(data).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: colors[label] || '#64748b', display: 'inline-block' }} />
            <span style={{ color: 'var(--text-secondary)' }}>{label}: <strong style={{ color: 'var(--text-primary)' }}>{value}</strong></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BarChart({ data, colors }) {
  const max = Math.max(...Object.values(data), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Object.entries(data).map(([label, value]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 90, fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
          <div style={{ flex: 1, background: 'var(--panel-bg)', borderRadius: 6, overflow: 'hidden', height: 18 }}>
            <div style={{ width: `${(value / max) * 100}%`, background: colors[label] || '#22d3ee', height: '100%', borderRadius: 6 }} />
          </div>
          <span style={{ width: 24, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ trend }) {
  const max = Math.max(...trend.map((d) => d.count), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
      {trend.map((d) => (
        <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div
            title={`${d.date}: ${d.count}`}
            style={{
              width: '100%',
              height: `${(d.count / max) * 90}px`,
              minHeight: d.count > 0 ? 3 : 0,
              background: '#22d3ee',
              borderRadius: '3px 3px 0 0',
            }}
          />
          <span style={{ fontSize: 9, color: 'var(--text-muted)', writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 30 }}>
            {d.date.slice(5)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Reports() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.get('/reports/summary').then(setSummary);
  }, []);

  if (!summary) return <div className="container"><p>Loading reports...</p></div>;

  return (
    <div className="container">
      <h2>Reports</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: -8 }}>Based on {summary.total} bug{summary.total !== 1 ? 's' : ''} you have visibility into.</p>

      <div className="card">
        <h4>Bugs by Status</h4>
        <DonutChart data={summary.byStatus} colors={STATUS_COLORS} />
      </div>

      <div className="card">
        <h4>Bugs by Severity</h4>
        <BarChart data={summary.bySeverity} colors={SEVERITY_COLORS} />
      </div>

      <div className="card">
        <h4>Bugs by Priority</h4>
        <BarChart data={summary.byPriority} colors={SEVERITY_COLORS} />
      </div>

      <div className="card">
        <h4>New Bugs — Last 14 Days</h4>
        <TrendChart trend={summary.trend} />
      </div>
    </div>
  );
}

/* ---------------- Root app ---------------- */

function AppShell() {
  const { user } = useAuth();
  const [view, setView] = useState('login');
  const [params, setParams] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(null); // null = still checking

  const nav = (v, p = {}) => { setView(v); setParams(p); };
  // Used by sidebar links specifically: navigate AND hide the sidebar so only the page shows.
  const navFromSidebar = (v, p = {}) => { nav(v, p); setSidebarOpen(false); };

  useEffect(() => {
    if (user && view === 'login') nav('dashboard');
    if (!user && view !== 'login') nav('login');
  }, [user]); // eslint-disable-line

  useEffect(() => {
    if (!user) {
      api.get('/auth/bootstrap-status').then((r) => setNeedsSetup(r.needsSetup)).catch(() => setNeedsSetup(false));
    }
  }, [user]);

  if (!user) {
    if (needsSetup === null) return <div className="auth-page"><p style={{ color: '#94a3b8' }}>Loading...</p></div>;
    return needsSetup ? <Setup nav={nav} /> : <Login nav={nav} />;
  }

  let Page = Dashboard;
  if (view === 'projects') Page = Projects;
  else if (view === 'bugs') Page = Bugs;
  else if (view === 'bugDetail') Page = BugDetail;
  else if (view === 'users') Page = Users;
  else if (view === 'reports') Page = Reports;
  else if (view === 'profile') Page = Profile;

  return (
    <div className="app-layout">
      {sidebarOpen && <Sidebar nav={nav} view={view} onNavigate={navFromSidebar} />}
      <div className="main-area">
        <div className="top-banner">
          <button className="menu-toggle" onClick={() => setSidebarOpen((o) => !o)} title="Toggle menu">☰</button>
          <span style={{ flex: 1 }}>AI Bug Tracking System</span>
          <NotificationBell nav={nav} />
          <ThemeToggle />
        </div>
        <Page nav={nav} params={params} />
      </div>
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <NotificationProvider>
          <AppShell />
        </NotificationProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
