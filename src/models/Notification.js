const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true },
    bug: { type: mongoose.Schema.Types.ObjectId, ref: 'Bug', default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    if (ret.bug) ret.bug = ret.bug.toString();
    delete ret._id;
    delete ret.__v;
  },
});

module.exports = mongoose.model('Notification', notificationSchema);
