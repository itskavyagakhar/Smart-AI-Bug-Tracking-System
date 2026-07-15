# Smart AI Bug Tracking System — MongoDB Edition

Same app, same UI, same 6 Gemini AI features — the only thing that changed from the
"simple" edition is the storage layer: this version uses real **MongoDB** (via Mongoose)
instead of a local JSON file. Everything else (single Express server, no frontend build
step, React loaded via CDN) is unchanged.

## What's implemented

- Auth: register/login, JWT, hashed passwords, roles (Admin / QA / Developer)
- Projects: create/view (Admin), QA + Developer team assignment
- Bugs: full CRUD, auto Bug ID, search + filters, assignment
- Enforced workflow: `Open → In Progress → Ready For Testing → Closed | Reopened → In Progress`
- Bug History: every action logged with user + timestamp
- Role-based dashboards with a Recent Activity feed
- Light/dark theme toggle (persists across sessions, available on every page including login)
- **File attachments** on bugs — upload screenshots, logs, PDFs, etc. (up to 10MB each, 5 per upload)
- **Real-time notifications** via Socket.io — instant alerts on assignment, status changes, comments; also emailed if SMTP is configured
- **Threaded comments** on every bug — post + reply, delete your own (or any, as Admin)
- **Profile page** — every user can update their own name and change their own password
- **Reports page** — donut chart (bugs by status), bar charts (by severity/priority), 14-day trend, all built with plain SVG (no charting library dependency)
- **Refresh-token authentication** — short-lived (15 min) access tokens + a 7-day refresh token stored as an httpOnly cookie, rotated on every use, revocable on logout
- 6 Gemini AI features, following the pipeline:
  ```
  AI Bug Description → AI Severity Prediction → AI Test Cases → AI Fix Suggestion
                                                                → AI Root Cause Analysis
  ```

## Requirements

- Node.js v18+
- A MongoDB database — either **MongoDB Atlas** (free tier, cloud) or a **local MongoDB** install

## 1. Get a MongoDB connection string

**Option A — MongoDB Atlas (recommended, no local install):**
1. Go to https://www.mongodb.com/cloud/atlas → sign up/log in
2. Create a free cluster (M0)
3. Database Access → create a DB user with a password
4. Network Access → add `0.0.0.0/0` (allow from anywhere, fine for development)
5. Connect → Drivers → copy the connection string:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/bugtracker?retryWrites=true&w=majority
   ```

**Option B — local MongoDB:**
If you have MongoDB installed and running locally, your connection string is simply:
```
mongodb://localhost:27017/bugtracker
```

## 2. Install and configure

```bash
cd smart-ai-bug-tracker-mongo
npm install
copy .env.example .env
```

Edit `.env`:
```
PORT=5000
JWT_SECRET=any_long_random_string_here
JWT_REFRESH_SECRET=a_different_long_random_string_here
MONGO_URI=<your connection string from step 1>
GEMINI_API_KEY=<optional, from https://aistudio.google.com>
SMTP_HOST=<optional, e.g. smtp.gmail.com>
SMTP_PORT=<optional, e.g. 587>
SMTP_USER=<optional>
SMTP_PASS=<optional>
SMTP_FROM=<optional>
```

`JWT_SECRET` and `JWT_REFRESH_SECRET` must be **two different** strings — one signs your 15-minute access tokens, the other signs the 7-day refresh token stored as a cookie. Everything SMTP-related is optional; leave it blank to skip email notifications entirely (in-app + real-time notifications still work regardless).

## 3. Run it

```bash
npm start
```

You should see:
```
MongoDB connected successfully

  Smart AI Bug Tracker is running!
  Open http://localhost:5000 in your browser
```

If instead you see `MongoDB connection failed`, double-check `MONGO_URI` — the most common
causes are a wrong password, unescaped special characters in the password, or the Atlas IP
whitelist not including your current IP (`0.0.0.0/0` covers this for development).

Then open **http://localhost:5000**.

### Quick start with ready-made accounts + demo data (optional)

Instead of going through the first-run Setup screen, you can seed the database with one
Admin, one QA, and one Developer account with known credentials — plus 3 demo projects
and 10 demo bugs spread across every status and severity, so the dashboard, Kanban board,
and AI features have something to look at immediately:

```bash
npm run seed
```

This creates:

| Role | Email | Password |
|---|---|---|
| Admin | admin@bugtracker.com | Admin@123 |
| QA | qa@bugtracker.com | Qa@12345 |
| Developer | dev@bugtracker.com | Dev@12345 |

...along with 3 projects (E-Commerce Website, Inventory Management System, HR Portal) and
10 bugs across them, in different statuses (Open, In Progress, Ready For Testing, Reopened,
Closed) so you can see the Kanban board and dashboard stats populated right away.

Safe to re-run — it skips anything that already exists rather than duplicating it.
**Change these passwords (or delete these accounts) before using this anywhere other than
local development**, since they're now public in this README.

> **Note on visibility**: QA and Developer accounts only see projects they're assigned to
> as team members (this is intentional). The seed script assigns *every* existing QA and
> Developer account to the 3 demo projects, so any QA/Developer login can see them.
>
> If your QA/Developer accounts still can't see projects — for example, if you had other
> projects in the database before seeding, or created projects manually — run:
> ```bash
> npm run fix-all-project-teams
> ```
> This adds every existing QA and Developer account to **every** project currently in the
> database, regardless of name. Or do it manually: Admin > Projects > select a project >
> Assign Team.

## Try the workflow

1. Register an **Admin** account, then a **QA** and a **Developer** account.
2. As **Admin**: Projects → + New Project → assign your QA and Developer to it.
3. As **QA**: Bugs → + Report Bug → enter Title + Steps to Reproduce → **✨ Generate Description (AI)**
   → **🎯 Predict Severity & Priority (AI)** → Create Bug.
4. Assign the bug to the Developer.
5. As **QA**, on the bug page: **Generate Test Cases**.
6. As **Developer**: **Suggest Fix**, optionally **Analyze Bug** (root cause), then move the bug
   through the workflow (In Progress → Ready For Testing).
7. As **QA**: Close or Reopen it.
8. Check **History** — every step, including every AI generation, is timestamped.

## Project structure

```
smart-ai-bug-tracker-mongo/
├── server.js              # Express entry point — connects to MongoDB, then starts the server
├── src/
│   ├── config.js            # MongoDB connection (Mongoose)
│   ├── models/
│   │   ├── User.js
│   │   ├── Project.js
│   │   ├── Bug.js             # includes testCases / fixSuggestion / rootCauseAnalysis fields
│   │   └── BugHistory.js
│   ├── auth.js               # password hashing, JWT, role middleware
│   ├── geminiService.js       # all 6 AI feature calls (with fallback if no API key)
│   └── routes.js              # all API endpoints
├── public/
│   ├── index.html             # loads React/Babel from CDN — unchanged from the simple edition
│   ├── app.jsx                 # the entire frontend — unchanged, talks to the same REST API
│   └── style.css
```

## Notes

- Every document gets a clean `id` field in API responses (Mongo's `_id` is converted automatically), so the frontend needed **zero changes** moving from the JSON-file edition to this one — it just talks to the same endpoints.
- Passwords are always excluded from any JSON response, even though they're stored hashed in the DB.
- If you ever want to go back to the zero-setup JSON-file edition (e.g. for a quick demo without a database), that's the "simple" edition — same features, same UI, just swap the storage layer back.
