import SupportConversation from "../models/SupportConversation.js";
import { getIO } from "../utils/socket.js";

function serialize(convo) {
  return convo.toObject ? convo.toObject() : convo;
}

/* GET /api/admin/support/conversations?status=&mine=true */
export const listConversations = async (req, res) => {
  try {
    const { status, mine } = req.query;
    const filter = {};
    if (status && ["AWAITING_AGENT", "IN_PROGRESS", "RESOLVED", "CLOSED"].includes(status)) {
      filter.status = status;
    }
    if (mine === "true") {
      filter.assignedAgentId = req.user.userId;
    }

    const conversations = await SupportConversation.find(filter)
      .sort({ updatedAt: -1 })
      .limit(100)
      .populate("userId", "name email")
      .populate("assignedAgentId", "name email");

    res.json({ conversations: conversations.map(serialize) });
  } catch (err) {
    console.error("List support conversations error:", err.message);
    res.status(500).json({ error: "Could not load conversations" });
  }
};

/* GET /api/admin/support/conversations/:id */
export const getConversation = async (req, res) => {
  try {
    const convo = await SupportConversation.findById(req.params.id)
      .populate("userId", "name email")
      .populate("assignedAgentId", "name email")
      .populate("orderId", "orderId stage totalPrice");

    if (!convo) return res.status(404).json({ error: "Conversation not found" });
    res.json({ conversation: serialize(convo) });
  } catch (err) {
    console.error("Get support conversation error:", err.message);
    res.status(500).json({ error: "Could not load conversation" });
  }
};

/* POST /api/admin/support/conversations/:id/messages — agent replies */
export const sendAgentMessage = async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Message cannot be empty" });
    }

    const convo = await SupportConversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ error: "Conversation not found" });
    if (convo.status === "CLOSED") {
      return res.status(400).json({ error: "This conversation is closed" });
    }

    const message = { sender: "AGENT", senderId: req.user.userId, text: text.trim() };
    convo.messages.push(message);

    // First reply auto-claims an unassigned conversation and moves it out
    // of the "awaiting" queue.
    if (!convo.assignedAgentId) convo.assignedAgentId = req.user.userId;
    if (convo.status === "AWAITING_AGENT") convo.status = "IN_PROGRESS";

    await convo.save();
    const savedMessage = convo.messages[convo.messages.length - 1];

    try {
      getIO().to(`user_${convo.userId}`).emit("support:new_message", {
        conversationId: convo._id,
        message: savedMessage,
      });
    } catch {
      // non-fatal
    }

    res.status(201).json({ message: savedMessage, conversation: serialize(convo) });
  } catch (err) {
    console.error("Send agent message error:", err.message);
    res.status(500).json({ error: "Could not send message" });
  }
};

/* PATCH /api/admin/support/conversations/:id — claim / resolve / close */
export const updateConversation = async (req, res) => {
  try {
    const { action } = req.body || {};
    if (!["claim", "resolve", "close", "reopen"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const convo = await SupportConversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ error: "Conversation not found" });

    if (action === "claim") {
      convo.assignedAgentId = req.user.userId;
      if (convo.status === "AWAITING_AGENT") convo.status = "IN_PROGRESS";
    } else if (action === "resolve") {
      convo.status = "RESOLVED";
    } else if (action === "close") {
      convo.status = "CLOSED";
    } else if (action === "reopen") {
      convo.status = convo.assignedAgentId ? "IN_PROGRESS" : "AWAITING_AGENT";
    }

    await convo.save();
    res.json({ conversation: serialize(convo) });
  } catch (err) {
    console.error("Update support conversation error:", err.message);
    res.status(500).json({ error: "Could not update conversation" });
  }
};
