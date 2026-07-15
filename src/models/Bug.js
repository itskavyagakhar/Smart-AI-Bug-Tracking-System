const mongoose = require('mongoose');

const bugSchema = new mongoose.Schema(
  {
    bugId: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    module: { type: String, default: '' },
    environment: { type: String, enum: ['Development', 'QA', 'UAT', 'Production'], default: 'Development' },

    stepsToReproduce: [{ type: String }],
    expectedResult: { type: String, default: '' },
    actualResult: { type: String, default: '' },
    aiSummary: { type: String, default: '' },

    severity: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], default: 'Medium' },
    priority: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], default: 'Medium' },
    aiSeverityReason: { type: String, default: '' },
    aiPriorityReason: { type: String, default: '' },

    // AI feature results, persisted once generated. Mixed + explicit null default so
    // these come back as null until an AI feature actually runs (not partially-filled objects).
    testCases: { type: mongoose.Schema.Types.Mixed, default: null },
    fixSuggestion: { type: mongoose.Schema.Types.Mixed, default: null },
    rootCauseAnalysis: { type: mongoose.Schema.Types.Mixed, default: null },

    attachments: [
      {
        filename: { type: String, required: true },
        filepath: { type: String, required: true },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    status: {
      type: String,
      enum: ['Open', 'In Progress', 'Ready For Testing', 'Closed', 'Reopened'],
      default: 'Open',
    },

    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    assignedDeveloper: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedDate: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

bugSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
  },
});

module.exports = mongoose.model('Bug', bugSchema);
