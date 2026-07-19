const COLORS = {
  ink: "#1D1C19",
  paper: "#FFFDF8",
  canvas: "#F6F3ED",
  stone: "#EEE7DD",
  line: "#D8D1C7",
  muted: "#706A61",
  clay: "#A85D37",
  olive: "#59634F",
};

const number = (value) => Number(value) || 0;
const clean = (value, fallback = "-") => {
  const text = String(value ?? "").trim().replace(/[–—]/g, "-");
  return text || fallback;
};

const money = (value) =>
  `INR ${number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const date = (value) =>
  new Date(value || Date.now()).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const drawRule = (doc, x1, y, x2, color = COLORS.line, width = 0.7) => {
  doc.moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(width).stroke();
};

const drawLabelValue = (doc, x, y, width, label, value) => {
  doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.muted).text(label.toUpperCase(), x, y, {
    width,
    characterSpacing: 0.7,
  });
  doc.font("Helvetica-Bold").fontSize(9.2).fillColor(COLORS.ink).text(clean(value), x, y + 12, {
    width,
    ellipsis: true,
  });
};

const drawPartyCard = (doc, x, y, width, height, title, lines) => {
  doc.roundedRect(x, y, width, height, 8).fillAndStroke(COLORS.canvas, COLORS.line);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.clay).text(title.toUpperCase(), x + 12, y + 12, {
    width: width - 24,
    characterSpacing: 0.8,
  });

  let textY = y + 30;
  lines.filter(Boolean).forEach((line, index) => {
    const font = index === 0 ? "Helvetica-Bold" : "Helvetica";
    const size = index === 0 ? 9.2 : 8.2;
    doc.font(font).fontSize(size).fillColor(index === 0 ? COLORS.ink : COLORS.muted);
    const value = clean(line);
    const lineHeight = doc.heightOfString(value, { width: width - 24, lineGap: 1 });
    if (textY + lineHeight <= y + height - 10) {
      doc.text(value, x + 12, textY, { width: width - 24, lineGap: 1 });
      textY += lineHeight + 3;
    }
  });
};

const drawPageHeader = (doc, { storeName, invoiceNo, continuation = false }) => {
  const pageW = doc.page.width;
  doc.rect(0, 0, pageW, 5).fill(COLORS.clay);
  doc.font("Helvetica-Bold").fontSize(continuation ? 14 : 25).fillColor(COLORS.ink).text(storeName, 42, continuation ? 24 : 34);

  if (continuation) {
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text(`Tax invoice ${invoiceNo} - continued`, 300, 28, {
      width: 253,
      align: "right",
    });
    drawRule(doc, 42, 52, 553);
  }
};

const drawItemsHeader = (doc, y) => {
  const x = 42;
  doc.rect(x, y, 511, 24).fill(COLORS.ink);
  doc.font("Helvetica-Bold").fontSize(7.2).fillColor(COLORS.paper);
  doc.text("DESCRIPTION", x + 10, y + 8, { width: 235, characterSpacing: 0.5 });
  doc.text("QTY", 292, y + 8, { width: 40, align: "center" });
  doc.text("UNIT PRICE", 337, y + 8, { width: 90, align: "right" });
  doc.text("AMOUNT", 437, y + 8, { width: 106, align: "right" });
  return y + 24;
};

const drawFooter = (doc, pageNumber, pageCount, settings) => {
  drawRule(doc, 42, 796, 553);
  const contact = [settings.supportEmail, settings.supportPhone].filter(Boolean).join("  |  ");
  doc.font("Helvetica").fontSize(7.4).fillColor(COLORS.muted).text(
    contact || "Thank you for shopping with VKart.",
    42,
    806,
    { width: 360 }
  );
  doc.text(`Page ${pageNumber} of ${pageCount}`, 445, 806, { width: 108, align: "right" });
  doc.fontSize(6.8).text("Computer-generated tax invoice and payment record. No signature required.", 42, 820, {
    width: 511,
    align: "center",
  });
};

export const renderTaxInvoice = ({ doc, order, settings = {} }) => {
  const storeName = clean(settings.storeName, "VKart");
  const tagline = clean(settings.tagline, "Curated commerce");
  const invoiceNo = clean(order.invoiceNumber || order.orderId || order._id);
  const orderNo = clean(order.orderId || order._id);
  const paymentStatus = clean(order.paymentStatus, "PENDING").toUpperCase();
  const products = Array.isArray(order.products) ? order.products : [];
  const subtotal = number(order.subtotal);
  const couponDiscount = number(order.discount);
  const membershipDiscount = number(order.membershipDiscount);
  const saleDiscount = number(order.saleDiscount);
  const totalDiscount = couponDiscount + membershipDiscount + saleDiscount;
  const merchandiseAfterDiscount = Math.max(0, subtotal - totalDiscount);
  const includedTax = number(order.tax);
  const taxableValue = Math.max(0, merchandiseAfterDiscount - includedTax);
  const total = number(order.totalPrice);

  drawPageHeader(doc, { storeName, invoiceNo });
  doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.muted).text(tagline, 42, 63, { width: 245 });
  doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.ink).text("TAX INVOICE", 335, 34, {
    width: 218,
    align: "right",
  });
  doc.font("Helvetica").fontSize(7).fillColor(COLORS.clay).text("ORIGINAL FOR RECIPIENT", 335, 61, {
    width: 218,
    align: "right",
    characterSpacing: 0.8,
  });
  drawRule(doc, 42, 92, 553);

  drawLabelValue(doc, 42, 108, 116, "Invoice number", invoiceNo);
  drawLabelValue(doc, 171, 108, 116, "Invoice date", date(order.createdAt));
  drawLabelValue(doc, 300, 108, 116, "Order reference", orderNo);
  drawLabelValue(doc, 429, 108, 124, "Payment status", paymentStatus);

  const cardsY = 152;
  const cardW = 163;
  const cardGap = 11;
  const sellerLines = [
    settings.address || "India",
    settings.gstNumber ? `GSTIN: ${settings.gstNumber}` : null,
    settings.supportEmail,
    settings.supportPhone,
  ];
  const customer = order.customer || {};
  drawPartyCard(doc, 42, cardsY, cardW, 112, "Sold by", [storeName, ...sellerLines]);
  drawPartyCard(doc, 42 + cardW + cardGap, cardsY, cardW, 112, "Bill to", [
    customer.name,
    customer.email,
    customer.phone,
  ]);
  drawPartyCard(doc, 42 + (cardW + cardGap) * 2, cardsY, cardW, 112, "Ship to", [
    customer.name,
    order.shippingAddress,
    customer.phone,
  ]);

  let cursorY = drawItemsHeader(doc, 282);
  products.forEach((product, index) => {
    const description = clean(product.name);
    const variant = product.selectedVariants ? clean(product.selectedVariants) : "";
    const descriptionHeight = doc.heightOfString(description, { width: 225, lineGap: 1 });
    const rowHeight = Math.max(38, descriptionHeight + (variant ? 16 : 10));

    if (cursorY + rowHeight > 690) {
      doc.addPage();
      drawPageHeader(doc, { storeName, invoiceNo, continuation: true });
      cursorY = drawItemsHeader(doc, 70);
    }

    if (index % 2 === 1) doc.rect(42, cursorY, 511, rowHeight).fill(COLORS.canvas);
    doc.font("Helvetica-Bold").fontSize(8.7).fillColor(COLORS.ink).text(description, 52, cursorY + 10, {
      width: 225,
      lineGap: 1,
    });
    if (variant) {
      doc.font("Helvetica").fontSize(7.3).fillColor(COLORS.muted).text(variant, 52, cursorY + 12 + descriptionHeight, {
        width: 225,
      });
    }
    doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.ink);
    doc.text(String(number(product.quantity)), 292, cursorY + 12, { width: 40, align: "center" });
    doc.text(money(product.price), 337, cursorY + 12, { width: 90, align: "right" });
    doc.font("Helvetica-Bold").text(
      money(number(product.lineTotal) || number(product.price) * number(product.quantity)),
      437,
      cursorY + 12,
      { width: 106, align: "right" }
    );
    drawRule(doc, 42, cursorY + rowHeight, 553, COLORS.line, 0.45);
    cursorY += rowHeight;
  });

  if (cursorY > 560) {
    doc.addPage();
    drawPageHeader(doc, { storeName, invoiceNo, continuation: true });
    cursorY = 76;
  } else {
    cursorY += 18;
  }

  const receiptX = 42;
  const receiptW = 238;
  const summaryX = 306;
  const summaryW = 247;
  const panelHeight = 170;

  doc.roundedRect(receiptX, cursorY, receiptW, panelHeight, 9).fillAndStroke(COLORS.canvas, COLORS.line);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.clay).text("PAYMENT RECEIPT", receiptX + 14, cursorY + 14, {
    characterSpacing: 0.8,
  });
  doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.ink).text(
    paymentStatus === "PAID" ? "Payment received" : "Payment pending",
    receiptX + 14,
    cursorY + 34,
    { width: receiptW - 28 }
  );

  const receiptMethod = number(order.walletUsed) > 0
    ? `${clean(order.paymentMethod)} + VKart Wallet`
    : clean(order.paymentMethod);
  const receiptLines = [
    ["Method", receiptMethod],
    ["Reference", order.paymentId || order.paymentOrderId || orderNo],
    [paymentStatus === "PAID" ? "Amount received" : "Amount due", money(total)],
  ];
  let receiptY = cursorY + 72;
  receiptLines.forEach(([label, value]) => {
    doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted).text(label, receiptX + 14, receiptY, { width: 78 });
    doc.font("Helvetica-Bold").fillColor(COLORS.ink).text(clean(value), receiptX + 92, receiptY, {
      width: receiptW - 106,
      ellipsis: true,
    });
    receiptY += 20;
  });

  doc.roundedRect(summaryX, cursorY, summaryW, panelHeight, 9).fillAndStroke(COLORS.paper, COLORS.line);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.clay).text("ORDER SUMMARY", summaryX + 14, cursorY + 14, {
    characterSpacing: 0.8,
  });
  let summaryY = cursorY + 36;
  const summaryLine = (label, value, options = {}) => {
    doc.font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.bold ? 10 : 8.2);
    doc.fillColor(options.color || COLORS.muted).text(label, summaryX + 14, summaryY, { width: 130 });
    doc.fillColor(options.bold ? COLORS.ink : (options.color || COLORS.ink)).text(value, summaryX + 144, summaryY, {
      width: summaryW - 158,
      align: "right",
    });
    summaryY += options.bold ? 23 : 17;
  };

  summaryLine("Merchandise (GST incl.)", money(subtotal));
  if (couponDiscount > 0) summaryLine(order.promo ? `Coupon: ${order.promo}` : "Coupon discount", `- ${money(couponDiscount)}`, { color: COLORS.olive });
  if (saleDiscount > 0) summaryLine("Sale savings", `- ${money(saleDiscount)}`, { color: COLORS.olive });
  if (membershipDiscount > 0) summaryLine("Prime savings", `- ${money(membershipDiscount)}`, { color: COLORS.olive });
  summaryLine("Shipping", number(order.shipping) > 0 ? money(order.shipping) : "Free");
  drawRule(doc, summaryX + 14, summaryY - 3, summaryX + summaryW - 14);
  summaryY += 4;
  summaryLine("Grand total", money(total), { bold: true });

  const taxY = cursorY + panelHeight + 13;
  doc.font("Helvetica").fontSize(7.3).fillColor(COLORS.muted).text(
    `GST included in merchandise value: ${money(includedTax)} at 18% | Taxable value: ${money(taxableValue)}`,
    42,
    taxY,
    { width: 511 }
  );
  doc.fontSize(7).text(
    "Returns, refunds and warranty support are governed by the order terms shown in your VKart account.",
    42,
    taxY + 15,
    { width: 511 }
  );

  const pageRange = doc.bufferedPageRange();
  for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    drawFooter(doc, pageIndex - pageRange.start + 1, pageRange.count, settings);
  }
};
