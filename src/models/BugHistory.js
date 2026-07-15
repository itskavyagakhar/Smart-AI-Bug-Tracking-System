const mongoose = require('mongoose');

const bugHistorySchema = new mongoose.Schema({
  bug: { type: mongoose.Schema.Types.ObjectId, ref: 'Bug', required: true },
  action: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  timestamp: { type: Date, default: Date.now },
});

bugHistorySchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
  },
});

module.exports = mongoose.model('BugHistory', bugHistorySchema);
