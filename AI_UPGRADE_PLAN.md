# VKart Copilot — AI Upgrade Plan

Status: **Draft for review.** Nothing here is built yet. The agentic feature list (Phase 3) is still to be confirmed.

Goal: take VKart Copilot from "basic vector RAG" to a production-style AI shopping assistant that we can explain and back up with numbers in an interview.

---

## 1. Where we are today

| Piece | File | What it does |
|---|---|---|
| Indexing | `scripts/vectorize-products.js`, `vectorizeProduct()` in `services/ai.service.js` | Builds one text from title, brand, category, description, tags and price, embeds it with `gemini-embedding-001` (768 dims) and stores it in `Product.embedding`. Re-embeds on admin create/update. |
| Query rewrite | `expandQuery()` | Uses chat history to turn a vague follow-up ("cheaper ones") into a standalone query. |
| Retrieval | `searchProducts()` | Runs Atlas `$vectorSearch` on `vector_index`, then filters `isActive`, `stock > 0` and `score >= 0.60` **after** the search, and keeps the top 4. |
| Keyword fallback | `keywordFallbackSearch()` | Runs only if vector search returns nothing or throws: `$text` first, then regex. |
| Generation | `generateSmartReply()` | Sends the top 4 products and the history to Gemini in JSON mode and gets back a summary, recommendation and follow-up. |
| Other AI | `parseSearchQuery()`, `generateReviewSummary()`, `generateComparisonSummary()`, `recommendation.controller.js` | Natural-language filter parsing, review summaries, compare verdicts, similar / for-you recommendations. |

**Gaps:**
- Keyword and vector results are never combined, so exact model names and SKUs ("Airdopes 141") can be missed.
- Filtering happens after `$vectorSearch`, so out-of-stock hits use up the result slots and we can end up with fewer than 4 products.
- The chat ignores price and rating ("under ₹2000"), even though `parseSearchQuery()` already exists.
- No reranking step.
- The pipeline is fixed (rewrite → search → answer); the model can't choose tools or take actions.
- No way to measure retrieval quality.
- The user's message is pasted straight into the prompt (prompt-injection risk).
- `langchain`, `@langchain/core` and `@langchain/google-genai` are in `package.json` but never imported.

---

## 2. Phases

Order matters: Phase 0 gives us a baseline score, so every later phase can show a before/after number.

### Phase 0 — Evaluation set (baseline first)

**Why:** without numbers, "hybrid is better" is just a claim.

- Add `tests/fixtures/retrieval-eval.json` with about 40 cases:
  ```json
  { "query": "boAt Airdopes 141", "expected": ["<productId>"], "type": "exact-name" }
  ```
  Mix the types: exact names/SKUs, vague intent ("something for gym"), price-bound ("earphones under 1500"), category, and typos.
- Add `scripts/eval-retrieval.js`, which runs every query through the retrieval function and prints:
  - **Recall@4**: did at least one expected product appear in the top 4?
  - **MRR**: how high did the first correct product rank?
- Record the baseline (current vector-only search) in this file under **Results**.

### Phase 1 — Retrieval: pre-filtering + hybrid search (RRF)

**1a. Pre-filter inside `$vectorSearch`**
- Add filter fields to the Atlas vector index definition (`vector_index`, edited in Atlas UI):
  ```json
  {
    "fields": [
      { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
      { "type": "filter", "path": "isActive" },
      { "type": "filter", "path": "stock" },
      { "type": "filter", "path": "category" },
      { "type": "filter", "path": "price" }
    ]
  }
  ```
- Move `isActive` / `stock` (and optional `category`, `price` range) into `$vectorSearch.filter`, so the top-K is taken from valid products only.
- Keep the post-search `score >= VECTOR_MIN_SCORE` check.

**1b. Hybrid search with Reciprocal Rank Fusion**
- New function `hybridSearch(query, filters, limit)` in `services/ai.service.js` (or a new `services/retrieval.service.js` if it grows):
  1. Run in parallel with `Promise.all`:
     - vector search → top 20 (with pre-filter)
     - keyword search → top 20 (existing `$text` index on title + description, same filters)
  2. Fuse in JS:
     `score(product) = Σ 1 / (60 + rank_in_list)` over the lists the product appears in (rank starts at 1).
  3. Sort by fused score and return the top N (N = 10, which feeds Phase 2).
- Fusion runs in app code, not `$rankFusion`, so it works on any MongoDB tier and stays easy to explain and test.
- If one side fails, use the other side's list alone (the same graceful degradation we have today).
- Later, optionally: swap `$text` for an Atlas Search (`$search`) index for typo tolerance and better ranking.

**Latency:** both searches run in parallel, so the added time is roughly the slower of the two (tens of milliseconds). The embedding call stays the biggest cost.

### Phase 2 — Reranking inside the answer call

**Decision:** no separate reranker model for now.

| Option | Extra latency | Extra cost | Verdict |
|---|---|---|---|
| Separate Gemini scoring call | ~1–2 s | Doubles calls per message on the free quota | No |
| Cohere / Jina rerank API | ~200–400 ms | New key + service | Maybe later |
| Local cross-encoder (`bge-reranker`) | ~100–300 ms | ~300 MB+ RAM on the server | No |
| **Answer call reranks** | **0** | **None** | **Yes** |

- Pass the top 10 fused results (not 4) to `generateSmartReply()`.
- Change the output JSON to return `rankedIndexes: [3, 1, 7, 2]` (best first, max 4) plus a reason per pick.
- Validate server-side: indexes must be integers in range and unique. Fall back to fused order if validation fails.
- The response returns products in `rankedIndexes` order (this replaces today's "move recommended item to front").
- Keep the prompt small: send title, brand, price, rating and a ~120-char description per product.

### Phase 3 — Agentic chat (tool calling)

**Idea:** instead of the fixed rewrite → search → answer pipeline, give Gemini a set of tools. The model decides which ones to call, sees the results, and may call more before answering.

**Loop (in a new `services/ai.agent.js`):**
1. Send the user message, short history and tool declarations to Gemini (function calling).
2. If the model returns a function call, run the matching server function, append the result and repeat.
3. Stop when the model returns a final answer, or after **max 4 tool calls** (hard cap for latency and quota).
4. Return `{ structured, products, actions }` to the frontend.

Gemini function calling probably can't be combined with `responseMimeType: "application/json"` in the same request; check this. If it can't, use a non-JSON model instance for the tool loop and keep JSON mode for the final answer step.

**Candidate tools (to be confirmed — see Open decisions):**

| ID | Tool | Backed by | Example user message |
|---|---|---|---|
| A | `search_products({ query, category?, minPrice?, maxPrice?, minRating?, sort? })` | `hybridSearch()` from Phase 1 + filters (categories grounded the same way `parseSearchQuery()` does it) | "Phones under ₹15k with 4+ rating" |
| B | `get_best_price({ productId })` | `getActiveSale()` + `overlaySalePricing()`, public coupons (`Coupon`: `isPublic`, `isActive`, `validTo`, `minOrder`), Prime status | "What's the cheapest I can get this for?" |
| C | Bundle builder (no new tool; the model calls `search_products` several times and checks the total against a budget) | Tool A + a small `sum_prices({ productIds })` helper so the arithmetic is exact | "Gaming setup under ₹60,000" |
| D | `search_reviews({ productId, topic })` | `Product.reviews` (keyword match on comments, then summarize) | "Do people complain about the battery?" |
| E | `propose_cart_action({ action: "add_to_cart" \| "add_to_wishlist", productId, qty? })` | **Does not write.** Returns a proposed action; the frontend shows a confirm button that calls the existing `PUT /profile/cart` / `PUT /profile/wishlist`. Logged-in users only. | "Add the second one to my wishlist" |
| F | `compare_products({ productIds })` | Existing `generateComparisonSummary()` + Redis cache | "Compare the first two" |
| G | `create_support_ticket({ summary })` | `SupportConversation` | "I want to talk to a person" |

**Out of scope:** order tracking. Order data/status flow is demo-only, so the bot must not claim delivery status.

**Safety rules for tools:**
- Tools receive `userId` from the authenticated request (`optionalAuth`), **never** from model arguments.
- Every argument is validated and clamped server-side (ids must be valid ObjectIds, prices ≥ 0, category from the real list).
- No tool writes user data directly. Writes go through an explicit user confirmation (tool E).
- Guests get only the read-only tools (A, B without Prime, C, D, F).

**Frontend (`vkart` repo, `src/components/AIChatAssistant.js`):**
- Render `actions[]` as confirm buttons ("Add boAt Airdopes 141 to cart?").
- Optional: show a small "Searched for: phones under ₹15,000" trace line, which makes the agent's steps visible in a demo.

### Phase 4 — Hardening

- **Prompt injection:**
  - Put the user's text and history inside clearly marked blocks (`<user_message>…</user_message>`) and tell the model that content inside them is data, not instructions.
  - Cap the message length and history length (number of turns and characters per turn).
  - Validate every model output against the expected shape. Never return raw model text as HTML.
- **Observability:** log one line per chat request with `{ requestId, query, rewrittenQuery, toolCalls, productIds, latencyMs, tokenUsage }` (no PII). Optional: an admin page or Langfuse later.
- **Semantic cache (optional):** cache answers keyed by query embedding. If a new query's cosine similarity to a cached query is ≥ 0.95, reuse the answer. Store in Redis with a short TTL. This saves Gemini quota.
- **Streaming (optional):** stream the summary text only. The products list and actions arrive as a final event.

### Phase 5 — Cleanup

- Remove the unused packages: `npm uninstall langchain @langchain/core @langchain/google-genai`.
- Unify the embedding text: `scripts/vectorize-products.js` and `vectorizeProduct()` build slightly different texts (the script omits `tags`). Use one shared helper so bulk and live re-indexing match.
- Update `tests/ai.test.js` and add unit tests for RRF fusion, `rankedIndexes` validation and tool argument validation.

---

## 3. Open decisions (review before building)

- [ ] **Which agentic tools?** Proposed: **A, B, C, E** (core). D, F, G are optional.
- [ ] Reranking inside the answer call (Phase 2) — OK?
- [ ] Keyword side: start with existing `$text`, or go straight to an Atlas Search (`$search`) index?
- [ ] Streaming in scope now, or later?
- [ ] Gemini free-tier quota: the agent loop uses up to 5 calls per message (4 tool rounds + answer). Is that acceptable, or do we lower the cap / add the semantic cache first?

---

## 4. Results (fill in while building)

| Stage | Recall@4 | MRR | Avg latency |
|---|---|---|---|
| Baseline (vector only, post-filter) | | | |
| + pre-filter | | | |
| + hybrid (RRF) | | | |
| + rerank in answer call | | | |

---

## 5. Interview talking points (once done)

- "Vector search missed exact model names, so I added keyword search and fused the two lists with Reciprocal Rank Fusion. Recall@4 went from X% to Y%."
- "I moved filters into the vector index so the top-K only contains in-stock products."
- "A separate reranker would add 200 ms to 2 s, so the answer call reranks the top 10. That costs zero extra calls."
- "The assistant is agentic: Gemini calls tools for filtered search, best price and budget bundles, capped at 4 steps. Anything that writes user data needs an explicit confirmation click."
- "I built it on the Gemini SDK and MongoDB directly, without LangChain, so every step is visible and testable."
