const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const MODEL = 'gemini-2.5-flash'; // gemini-1.5-flash was fully shut down by Google — do not revert to it

/* ---------------- shared helpers ---------------- */

async function callGemini(prompt) {
  if (!genAI) return null; // no key configured -> caller falls back
  const model = genAI.getGenerativeModel({ model: MODEL });
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip markdown code fences regardless of language tag (```json, ```, etc.)
  let cleaned = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Fallback: extract the first {...} block in case the model added stray text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}

async function safeCall(prompt, fallbackFn) {
  try {
    const parsed = await callGemini(prompt);
    if (!parsed) return fallbackFn();
    return parsed;
  } catch (err) {
    console.error('Gemini call failed, using fallback:', err.message);
    return fallbackFn();
  }
}

/* ---------------- 1. Bug Description Generator ---------------- */
// Input: Title + Steps to Reproduce -> Output: Description, Expected Result, Actual Result

async function generateDescription({ projectName, projectDescription, title, stepsToReproduce }) {
  const stepsText = (stepsToReproduce || []).map((s, i) => `${i + 1}. ${s}`).join('\n');

  const prompt = `You are an assistant in a bug tracking system.

Project: ${projectName}
Project Description: ${projectDescription}

Bug Title: "${title}"
Steps to Reproduce:
${stepsText}

Based on the title and steps, generate a bug report. Respond ONLY with valid JSON, no markdown fences:

{
  "description": "one or two sentence clear description of the issue",
  "expectedResult": "what should happen",
  "actualResult": "what actually happens"
}`;

  return safeCall(prompt, () => ({
    description: title,
    expectedResult: 'The feature should work as intended without errors.',
    actualResult: `Issue observed: ${title}`,
  }));
}

/* ---------------- 2 & 3. Severity + Priority Prediction ---------------- */

async function predictSeverityPriority({ projectName, projectDescription, title, description }) {
  const prompt = `You are an assistant in a bug tracking system that predicts bug severity and priority.

Project: ${projectName}
Project Description: ${projectDescription}

Bug Title: "${title}"
Bug Description: "${description}"

Respond ONLY with valid JSON, no markdown fences:

{
  "severity": "Low | Medium | High | Critical",
  "severityReason": "one sentence explaining why",
  "priority": "Low | Medium | High | Critical",
  "priorityReason": "one sentence explaining why"
}`;

  return safeCall(prompt, () => ({
    severity: 'Medium',
    severityReason: 'Default severity assigned — connect a Gemini API key for AI-based prediction.',
    priority: 'Medium',
    priorityReason: 'Default priority assigned — connect a Gemini API key for AI-based prediction.',
  }));
}

/* ---------------- 4. Fix Suggestion (Developer / QA) ---------------- */

async function generateFixSuggestion({ projectName, projectDescription, title, description, stepsToReproduce }) {
  const stepsText = (stepsToReproduce || []).map((s, i) => `${i + 1}. ${s}`).join('\n');

  const prompt = `You are a senior developer assistant in a bug tracking system.

Project: ${projectName}
Project Description: ${projectDescription}

Bug Title: "${title}"
Bug Description: "${description}"
Steps to Reproduce:
${stepsText}

Suggest likely causes and a fix. Respond ONLY with valid JSON, no markdown fences:

{
  "possibleCauses": ["likely cause 1", "likely cause 2", "likely cause 3"],
  "possibleFix": "concrete suggested fix",
  "filesToCheck": ["file or module 1", "file or module 2"]
}`;

  return safeCall(prompt, () => ({
    possibleCauses: ['Unable to determine automatically — connect a Gemini API key for AI-based analysis.'],
    possibleFix: 'Review the relevant controller/component manually based on the steps to reproduce.',
    filesToCheck: [],
  }));
}

/* ---------------- 5. Test Cases Generator ---------------- */

async function generateTestCases({ projectName, projectDescription, title, description }) {
  const prompt = `You are a QA assistant in a bug tracking system.

Project: ${projectName}
Project Description: ${projectDescription}

Bug Title: "${title}"
Bug Description: "${description}"

Generate test cases to verify this bug and its fix. Respond ONLY with valid JSON, no markdown fences:

{
  "positive": ["positive test case 1", "positive test case 2"],
  "negative": ["negative test case 1", "negative test case 2"],
  "boundary": ["boundary test case 1", "boundary test case 2"]
}`;

  return safeCall(prompt, () => ({
    positive: ['Verify the feature works correctly with valid input.'],
    negative: ['Verify appropriate error handling with invalid input.'],
    boundary: ['Verify behavior at input limits (empty, max length, etc).'],
  }));
}

/* ---------------- 6. Root Cause Analysis (Developer) ---------------- */

async function generateRootCauseAnalysis({ projectName, projectDescription, title, description, stepsToReproduce }) {
  const stepsText = (stepsToReproduce || []).map((s, i) => `${i + 1}. ${s}`).join('\n');

  const prompt = `You are a senior developer performing root cause analysis in a bug tracking system.

Project: ${projectName}
Project Description: ${projectDescription}

Bug Title: "${title}"
Bug Description: "${description}"
Steps to Reproduce:
${stepsText}

Respond ONLY with valid JSON, no markdown fences:

{
  "rootCause": "likely underlying root cause",
  "affectedModules": ["module 1", "module 2"],
  "riskLevel": "Low | Medium | High | Critical"
}`;

  return safeCall(prompt, () => ({
    rootCause: 'Unable to determine automatically — connect a Gemini API key for AI-based analysis.',
    affectedModules: [],
    riskLevel: 'Medium',
  }));
}

/* ---------------- 7. AI Bug Summary ---------------- */
// Input: a raw/verbose bug description -> Output: one clean, concise summary sentence

async function generateSummary({ projectName, projectDescription, description }) {
  const prompt = `You are an assistant in a bug tracking system.

Project: ${projectName}
Project Description: ${projectDescription}

Raw bug description as written by the tester:
"${description}"

Write ONE clear, concise summary sentence capturing the issue. Respond ONLY with valid JSON, no markdown fences:

{
  "summary": "one concise sentence summarizing the bug"
}`;

  return safeCall(prompt, () => ({
    summary: description.length > 140 ? description.slice(0, 140).trim() + '…' : description,
  }));
}

/* ---------------- 8. Duplicate Bug Detection ---------------- */
// Compares a new bug's title+description against existing bugs in the same project

async function detectDuplicate({ projectName, projectDescription, title, description, existingBugs }) {
  if (!existingBugs || existingBugs.length === 0) {
    return { isDuplicate: false, duplicateBugId: null, duplicateTitle: null, reason: 'No existing bugs to compare against.' };
  }

  const bugList = existingBugs
    .map((b) => `- [${b.bugId}] "${b.title}": ${b.description}`)
    .join('\n');

  const prompt = `You are an assistant in a bug tracking system that detects duplicate bug reports.

Project: ${projectName}
Project Description: ${projectDescription}

New bug being reported:
Title: "${title}"
Description: "${description}"

Existing bugs already reported in this project:
${bugList}

Does the new bug appear to be a duplicate of any existing bug (same underlying issue, even if worded differently)?
Respond ONLY with valid JSON, no markdown fences:

{
  "isDuplicate": true or false,
  "duplicateBugId": "the bugId string of the matching bug, or null if no duplicate",
  "duplicateTitle": "the title of the matching bug, or null if no duplicate",
  "reason": "one sentence explaining the decision"
}`;

  return safeCall(prompt, () => ({
    isDuplicate: false,
    duplicateBugId: null,
    duplicateTitle: null,
    reason: 'Unable to check automatically — connect a Gemini API key for AI-based duplicate detection.',
  }));
}

/* ---------------- 9. AI Chat Assistant ---------------- */
// Free-form Q&A about a specific bug, using its full context

async function answerBugQuestion({ bugContext, question }) {
  const prompt = `You are an assistant embedded in a bug tracking system, helping a user understand a specific bug.

Bug context:
${bugContext}

The user asks: "${question}"

Answer clearly and concisely, using only the context given. If the context doesn't contain the answer, say so honestly.
Respond ONLY with valid JSON, no markdown fences:

{
  "answer": "your answer here"
}`;

  return safeCall(prompt, () => ({
    answer: 'AI chat is not available right now — connect a Gemini API key to enable this feature.',
  }));
}

module.exports = {
  generateDescription,
  predictSeverityPriority,
  generateFixSuggestion,
  generateTestCases,
  generateRootCauseAnalysis,
  generateSummary,
  detectDuplicate,
  answerBugQuestion,
};
