// Adds every existing QA and Developer account to EVERY project currently in the
// database, regardless of name — use this if your projects (demo or manually
// created) aren't showing up for your QA/Developer test logins.
//
// Run with: node scripts/fix-all-project-teams.js

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Project = require('../src/models/Project');

async function run() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  const qaUsers = await User.find({ role: 'QA' });
  const devUsers = await User.find({ role: 'Developer' });
  const qaIds = qaUsers.map((u) => u._id);
  const devIds = devUsers.map((u) => u._id);

  console.log(`Found ${qaIds.length} QA account(s): ${qaUsers.map((u) => u.email).join(', ') || '(none)'}`);
  console.log(`Found ${devIds.length} Developer account(s): ${devUsers.map((u) => u.email).join(', ') || '(none)'}\n`);

  const projects = await Project.find({});
  console.log(`Found ${projects.length} project(s) in the database.\n`);

  if (projects.length === 0) {
    console.log('Nothing to update — no projects exist yet. Create one from Admin > Projects first.');
  }

  for (const project of projects) {
    project.qaMembers = qaIds;
    project.developers = devIds;
    await project.save();
    console.log(`Updated: "${project.name}" — now visible to all QA and Developer accounts`);
  }

  console.log(`\nDone. ${projects.length} project(s) updated.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
