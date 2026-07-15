// One-time seed script: creates an Admin, a QA (Tester), and a Developer account
// directly in the database, with known credentials, so you don't have to go
// through the first-run Setup screen or the Users page to get started.
// Also seeds a handful of demo projects and bugs spread across every status/severity
// so the dashboard, Kanban board, and AI features have something to look at immediately.
//
// Run with: npm run seed

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Project = require('../src/models/Project');
const Bug = require('../src/models/Bug');
const BugHistory = require('../src/models/BugHistory');
const { hashPassword } = require('../src/auth');

const SEED_USERS = [
  { name: 'Admin User', email: 'admin@bugtracker.com', password: 'Admin@123', role: 'Admin' },
  { name: 'QA Tester', email: 'qa@bugtracker.com', password: 'Qa@12345', role: 'QA' },
  { name: 'Dev User', email: 'dev@bugtracker.com', password: 'Dev@12345', role: 'Developer' },
];

const daysAgo = (n, hourOffset = 0) => new Date(Date.now() - n * 24 * 60 * 60 * 1000 + hourOffset * 60 * 60 * 1000);

async function seedUsers() {
  const created = {};
  for (const u of SEED_USERS) {
    let user = await User.findOne({ email: u.email });
    if (user) {
      console.log(`Skipped (already exists): ${u.role} — ${u.email}`);
    } else {
      const hashed = await hashPassword(u.password);
      user = await User.create({ name: u.name, email: u.email, password: hashed, role: u.role });
      console.log(`Created: ${u.role} — ${u.email}`);
    }
    created[u.role] = user;
  }
  return created;
}

async function seedProjectsAndBugs(users) {
  const qa = users.QA;
  const dev = users.Developer;

  // Assign every existing QA and Developer account to the demo projects — not just the
  // one seeded here — so this works regardless of which QA/Developer logins are used to test.
  const allQaUsers = await User.find({ role: 'QA' });
  const allDevUsers = await User.find({ role: 'Developer' });
  const qaMemberIds = allQaUsers.map((u) => u._id);
  const developerIds = allDevUsers.map((u) => u._id);

  const projectDefs = [
    {
      name: 'E-Commerce Website',
      description: 'Online shopping platform for browsing products, managing the cart, and checkout.',
      startDate: daysAgo(30),
    },
    {
      name: 'Inventory Management System',
      description: 'Tracks stock levels, vendors, purchase orders, and warehouse receiving.',
      startDate: daysAgo(45),
    },
    {
      name: 'HR Portal',
      description: 'Employee records, leave requests, and payroll processing.',
      startDate: daysAgo(20),
    },
  ];

  // Per-project idempotency: only skip a demo project if ONE WITH THAT EXACT NAME already
  // exists — unrelated pre-existing projects no longer block demo data from being created.
  const projects = {};
  for (const p of projectDefs) {
    let project = await Project.findOne({ name: p.name });
    if (project) {
      console.log(`Skipped (already exists): ${p.name}`);
    } else {
      project = await Project.create({
        ...p,
        status: 'Active',
        qaMembers: qaMemberIds,
        developers: developerIds,
        createdBy: users.Admin._id,
      });
      console.log(`Created project: ${p.name} (${qaMemberIds.length} QA, ${developerIds.length} Developer(s) assigned)`);
    }
    projects[p.name] = project;
  }

  const bugDefs = [
    // E-Commerce Website
    {
      project: 'E-Commerce Website', title: 'Login button not working',
      description: 'Clicking the login button does nothing after entering valid credentials.',
      stepsToReproduce: ['Open the login page', 'Enter a valid email and password', 'Click the Login button'],
      expectedResult: 'User should be redirected to the dashboard.',
      actualResult: 'Nothing happens after clicking Login.',
      severity: 'High', priority: 'High', status: 'Open', assigned: false, daysOld: 2,
    },
    {
      project: 'E-Commerce Website', title: 'Cart total incorrect after applying coupon',
      description: 'The cart total does not update correctly after a valid coupon code is applied.',
      stepsToReproduce: ['Add two items to the cart', 'Go to checkout', 'Apply coupon SAVE10', 'Check the total'],
      expectedResult: 'Total should reflect a 10% discount.',
      actualResult: 'Total remains unchanged.',
      severity: 'Medium', priority: 'High', status: 'In Progress', assigned: true, daysOld: 4,
    },
    {
      project: 'E-Commerce Website', title: 'Checkout page crashes on Safari',
      description: 'The checkout page shows a blank screen when opened in Safari.',
      stepsToReproduce: ['Open the site in Safari', 'Add an item to the cart', 'Proceed to checkout'],
      expectedResult: 'Checkout form should load normally.',
      actualResult: 'Page goes blank, console shows a JS error.',
      severity: 'Critical', priority: 'Critical', status: 'Ready For Testing', assigned: true, daysOld: 6,
    },
    {
      project: 'E-Commerce Website', title: 'Product images not loading',
      description: 'Some product thumbnails show a broken image icon on the listing page.',
      stepsToReproduce: ['Open the product listing page', 'Scroll through the grid'],
      expectedResult: 'All product images should load.',
      actualResult: 'A few thumbnails are broken.',
      severity: 'Low', priority: 'Medium', status: 'Closed', assigned: true, daysOld: 10,
    },
    // Inventory Management System
    {
      project: 'Inventory Management System', title: 'Stock count mismatch after bulk upload',
      description: 'Stock quantities are inconsistent after uploading a bulk CSV update.',
      stepsToReproduce: ['Go to Inventory > Bulk Upload', 'Upload a CSV with 50 SKUs', 'Check stock counts afterward'],
      expectedResult: 'Stock counts should match the CSV exactly.',
      actualResult: 'Around 5% of SKUs show incorrect counts.',
      severity: 'High', priority: 'High', status: 'Open', assigned: false, daysOld: 1,
    },
    {
      project: 'Inventory Management System', title: 'Vendor email not sending on order confirmation',
      description: 'Vendors are not receiving confirmation emails when a purchase order is created.',
      stepsToReproduce: ['Create a new purchase order', 'Submit it', 'Check the vendor inbox'],
      expectedResult: 'Vendor should receive a confirmation email within a minute.',
      actualResult: 'No email is received.',
      severity: 'Medium', priority: 'Medium', status: 'Reopened', assigned: true, daysOld: 8,
    },
    {
      project: 'Inventory Management System', title: 'Warehouse filter dropdown empty',
      description: 'The warehouse filter on the stock report page shows no options.',
      stepsToReproduce: ['Go to Reports > Stock Report', 'Click the Warehouse filter dropdown'],
      expectedResult: 'Dropdown should list all active warehouses.',
      actualResult: 'Dropdown is empty.',
      severity: 'Low', priority: 'Low', status: 'In Progress', assigned: true, daysOld: 3,
    },
    // HR Portal
    {
      project: 'HR Portal', title: 'Leave balance shows negative value',
      description: 'An employee\'s leave balance is displaying as -2 days after approval of a leave request.',
      stepsToReproduce: ['Log in as an employee with 5 leave days', 'Apply for 3 days leave', 'Get it approved', 'Apply for 4 more days'],
      expectedResult: 'System should prevent leave that exceeds the balance.',
      actualResult: 'Leave is approved and balance goes negative.',
      severity: 'Critical', priority: 'Critical', status: 'Open', assigned: false, daysOld: 1,
    },
    {
      project: 'HR Portal', title: 'Payslip PDF download fails',
      description: 'Clicking "Download Payslip" shows a spinner forever and never downloads the file.',
      stepsToReproduce: ['Log in as an employee', 'Go to Payslips', 'Click Download for the latest month'],
      expectedResult: 'PDF should download within a few seconds.',
      actualResult: 'Spinner never stops, no file is downloaded.',
      severity: 'High', priority: 'Medium', status: 'Ready For Testing', assigned: true, daysOld: 5,
    },
    {
      project: 'HR Portal', title: 'Employee search is case-sensitive',
      description: 'Searching for an employee by name only works if the case matches exactly.',
      stepsToReproduce: ['Go to Employee Directory', 'Search "john" (lowercase) for an employee named "John Smith"'],
      expectedResult: 'Search should be case-insensitive.',
      actualResult: 'No results are returned.',
      severity: 'Low', priority: 'Low', status: 'Closed', assigned: true, daysOld: 12,
    },
  ];

  let bugCounter = await Bug.countDocuments();
  for (const b of bugDefs) {
    const existingBug = await Bug.findOne({ title: b.title, project: projects[b.project]._id });
    if (existingBug) {
      console.log(`Skipped (already exists): ${existingBug.bugId} — ${b.title}`);
      continue;
    }

    bugCounter += 1;
    const bugId = `BUG-${String(bugCounter).padStart(4, '0')}`;
    const createdAt = daysAgo(b.daysOld);

    const bug = await Bug.create({
      bugId,
      title: b.title,
      description: b.description,
      project: projects[b.project]._id,
      stepsToReproduce: b.stepsToReproduce,
      expectedResult: b.expectedResult,
      actualResult: b.actualResult,
      severity: b.severity,
      priority: b.priority,
      status: b.status,
      assignedDeveloper: b.assigned ? dev._id : null,
      assignedDate: b.assigned ? daysAgo(b.daysOld, 1) : null,
      createdBy: qa._id,
      createdAt,
    });

    await BugHistory.create({ bug: bug._id, action: 'Bug Created', user: qa._id, timestamp: daysAgo(b.daysOld) });
    if (b.assigned) {
      await BugHistory.create({ bug: bug._id, action: 'Bug Assigned to Developer', user: qa._id, timestamp: daysAgo(b.daysOld, 1) });
    }
    if (b.status !== 'Open') {
      await BugHistory.create({ bug: bug._id, action: `Status changed to ${b.status}`, user: b.assigned ? dev._id : qa._id, timestamp: daysAgo(Math.max(b.daysOld - 1, 0), 2) });
    }

    console.log(`Created bug: ${bugId} — ${b.title} [${b.status}]`);
  }
}

async function seed() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set in .env — cannot seed without a database connection.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  const users = await seedUsers();
  await seedProjectsAndBugs(users);

  console.log('\nLogin credentials:');
  SEED_USERS.forEach((u) => console.log(`  ${u.role.padEnd(10)} ${u.email}  /  ${u.password}`));
  console.log('\nDone.');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
