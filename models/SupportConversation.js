import mongoose from "mongoose";
const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    sender: { type: String, enum: ["USER", "AGENT"], required: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User" },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const supportConversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },

    // Snapshot of what the guided bot flow already gathered, so an agent
    // opening the thread has context without the customer repeating it.
    category: {
      type: String,
      enum: ["ORDER_STATUS", "RETURN_REFUND", "PAYMENT", "OTHER"],
      default: "OTHER",
    },
    contextSummary: { type: String, trim: true, maxlength: 300 },

    status: {
      type: String,
      enum: ["AWAITING_AGENT", "IN_PROGRESS", "RESOLVED", "CLOSED"],
      default: "AWAITING_AGENT",
      index: true,
    },
    assignedAgentId: { type: Schema.Types.ObjectId, ref: "User" },

    messages: [messageSchema],
  },
  { timestamps: true, versionKey: false }
);

supportConversationSchema.index({ status: 1, updatedAt: -1 });

const SupportConversation = mongoose.model("SupportConversation", supportConversationSchema);
export default SupportConversation;
