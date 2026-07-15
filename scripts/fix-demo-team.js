// Fixes team assignment on demo projects that were already seeded before this fix —
// adds every existing QA and Developer account to the 3 demo projects, so any
// QA/Developer login can see them (not just the exact seeded accounts).
//
// Run with: node scripts/fix-demo-team.js

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Project = require('../src/models/Project');

const DEMO_PROJECT_NAMES = ['E-Commerce Website', 'Inventory Management System', 'HR Portal'];

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

  console.log(`Found ${qaIds.length} QA account(s) and ${devIds.length} Developer account(s).\n`);

  let updated = 0;
  for (const name of DEMO_PROJECT_NAMES) {
    const project = await Project.findOne({ name });
    if (!project) {
      console.log(`Skipped (not found): ${name}`);
      continue;
    }
    project.qaMembers = qaIds;
    project.developers = devIds;
    await project.save();
    updated += 1;
    console.log(`Updated: ${name} — now visible to all ${qaIds.length} QA and ${devIds.length} Developer account(s)`);
  }

  console.log(`\nDone. ${updated} project(s) updated.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
