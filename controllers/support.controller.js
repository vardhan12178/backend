import SupportConversation from "../models/SupportConversation.js";
import { getIO } from "../utils/socket.js";

const CATEGORIES = ["ORDER_STATUS", "RETURN_REFUND", "PAYMENT", "OTHER"];

function serialize(convo) {
  const obj = convo.toObject ? convo.toObject() : convo;
  return obj;
}

/* POST /api/support/conversations — customer starts (or reopens) a chat */
export const createConversation = async (req, res) => {
  try {
    const { category, orderId, contextSummary } = req.body || {};

    // Resume an existing open conversation rather than spawning duplicates
    // if the widget is reopened before the last one was resolved.
    const existing = await SupportConversation.findOne({
      userId: req.user.userId,
      status: { $in: ["AWAITING_AGENT", "IN_PROGRESS"] },
    }).sort({ createdAt: -1 });

    if (existing) {
      return res.status(200).json({ conversation: serialize(existing), resumed: true });
    }

    const convo = await SupportConversation.create({
      userId: req.user.userId,
      orderId: orderId || undefined,
      category: CATEGORIES.includes(category) ? category : "OTHER",
      contextSummary: typeof contextSummary === "string" ? contextSummary.slice(0, 300) : "",
      messages: [],
    });

    try {
      getIO().to("support_agents").emit("support:new_conversation", { conversation: serialize(convo) });
    } catch {
      // Socket not initialized (e.g. in tests) — non-fatal, agents will still
      // see it next time they load the inbox.
    }

    res.status(201).json({ conversation: serialize(convo), resumed: false });
  } catch (err) {
    console.error("Create support conversation error:", err.message);
    res.status(500).json({ error: "Could not start a conversation" });
  }
};

/* GET /api/support/conversations/mine — resume the customer's own open thread */
export const getMyConversation = async (req, res) => {
  try {
    const convo = await SupportConversation.findOne({
      userId: req.user.userId,
      status: { $in: ["AWAITING_AGENT", "IN_PROGRESS"] },
    }).sort({ createdAt: -1 });

    res.json({ conversation: convo ? serialize(convo) : null });
  } catch (err) {
    console.error("Get my support conversation error:", err.message);
    res.status(500).json({ error: "Could not load your conversation" });
  }
};

/* POST /api/support/conversations/:id/messages — customer sends a message */
export const sendMessage = async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Message cannot be empty" });
    }

    const convo = await SupportConversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ error: "Conversation not found" });
    if (String(convo.userId) !== String(req.user.userId)) {
      return res.status(403).json({ error: "Not your conversation" });
    }
    if (convo.status === "CLOSED") {
      return res.status(400).json({ error: "This conversation is closed" });
    }

    const message = { sender: "USER", senderId: req.user.userId, text: text.trim() };
    convo.messages.push(message);
    // A resolved conversation re-opens if the customer follows up.
    if (convo.status === "RESOLVED") convo.status = "AWAITING_AGENT";
    await convo.save();

    const savedMessage = convo.messages[convo.messages.length - 1];

    try {
      getIO().to("support_agents").emit("support:new_message", {
        conversationId: convo._id,
        message: savedMessage,
        customerId: convo.userId,
      });
    } catch {
      // non-fatal
    }

    res.status(201).json({ message: savedMessage, conversation: serialize(convo) });
  } catch (err) {
    console.error("Send support message error:", err.message);
    res.status(500).json({ error: "Could not send message" });
  }
};
