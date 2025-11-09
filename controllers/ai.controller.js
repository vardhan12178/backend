import nlp from "compromise";
import natural from "natural";
import Order from "../models/Order.js";
import User from "../models/User.js";

const tokenizer = new natural.WordTokenizer();
const stemmer = natural.PorterStemmer;

// ----------------------------
// 🧠 Intent Detection
// ----------------------------
function detectIntent(query) {
  const text = query.toLowerCase();
  if (text.includes("order") || text.includes("track") || text.includes("package") || text.includes("delivery"))
    return "order_status";
  if (text.includes("recommend") || text.includes("suggest") || text.includes("similar"))
    return "recommendation";
  if (text.includes("cancel"))
    return "cancel_order";
  if (text.includes("hello") || text.includes("hi") || text.includes("hey"))
    return "greeting";
  return "unknown";
}

// ----------------------------
// 🧩 Template response generator
// ----------------------------
function templateResponse(intent, data = {}) {
  const responses = {
    greeting: [
      "Hey there 👋 I'm your VKart Assistant! You can ask about your order status, delivery date, or get product suggestions.",
      "Hello! 👋 How can I help you today? You can ask me to check your order status or get new product ideas."
    ],
    order_status: [
      `Your latest order for **${data.productList || "items"}** is currently **${data.stage || "PLACED"}**.`,
      `I checked your account — your order (${data.productList || "items"}) is **${data.stage || "in progress"}**.`,
    ],
    order_no_data: [
      "I couldn’t find any active or recent orders linked to your account.",
      "Looks like there are no recent orders placed from your account."
    ],
    recommendation: [
      `Based on your previous purchases like **${data.productKeywords || "your items"}**, you might like exploring similar products soon!`,
      `I’d suggest checking our new arrivals inspired by your past orders — especially related to **${data.productKeywords || "your favorites"}**.`
    ],
    cancel_order: [
      "If you’d like to cancel an order, please open your Orders page and click *Cancel Order* for the respective item. I can’t directly cancel it for you yet."
    ],
    unknown: [
      "Hmm, I couldn’t quite catch that 🤔 — try asking about your order status or product suggestions.",
      "I can help you with orders or recommendations. Try asking *‘What’s my latest order status?’*"
    ]
  };

  const list = responses[intent] || responses.unknown;
  return list[Math.floor(Math.random() * list.length)];
}

// ----------------------------
// ⚙️ Main AI Controller
// ----------------------------
export const handleAIQuery = async (req, res) => {
  try {
    const { query, userId } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const cleanQuery = nlp(query).normalize().text();
    const intent = detectIntent(cleanQuery);
    const tokens = tokenizer.tokenize(cleanQuery).map(t => stemmer.stem(t));

    let answer = "";
    let contextData = {};

    // ------------------------------
    // INTENT: ORDER STATUS
    // ------------------------------
    if (intent === "order_status") {
      const lastOrder = await Order.findOne({ userId }).sort({ createdAt: -1 });
      if (!lastOrder) {
        answer = templateResponse("order_no_data");
      } else {
        const products = lastOrder.products.map(p => `${p.quantity}× ${p.name}`).join(", ");
        contextData = {
          productList: products,
          stage: lastOrder.stage
        };
        answer = templateResponse("order_status", contextData);
      }
    }

    // ------------------------------
    // INTENT: PRODUCT RECOMMENDATION
    // ------------------------------
    else if (intent === "recommendation") {
      const recentOrders = await Order.find({ userId }).sort({ createdAt: -1 }).limit(3);
      if (!recentOrders.length) {
        answer = "You haven’t placed any orders yet. Once you start shopping, I’ll recommend new items!";
      } else {
        // Extract product keywords from past orders
        const names = recentOrders.flatMap(o => o.products.map(p => p.name));
        const keywords = Array.from(new Set(names.map(n => n.split(" ")[0]))).slice(0, 3).join(", ");
        contextData.productKeywords = keywords;
        answer = templateResponse("recommendation", contextData);
      }
    }

    // ------------------------------
    // INTENT: CANCEL ORDER
    // ------------------------------
    else if (intent === "cancel_order") {
      answer = templateResponse("cancel_order");
    }

    // ------------------------------
    // INTENT: GREETING
    // ------------------------------
    else if (intent === "greeting") {
      answer = templateResponse("greeting");
    }

    // ------------------------------
    // DEFAULT: UNKNOWN
    // ------------------------------
    else {
      answer = templateResponse("unknown");
    }

    // ------------------------------
    // RESPONSE
    // ------------------------------
    return res.json({
      intent,
      tokens,
      context: contextData,
      answer,
      success: true
    });

  } catch (err) {
    console.error("AI error:", err);
    res.status(500).json({
      success: false,
      error: "AI Assistant failed to process the request."
    });
  }
};
