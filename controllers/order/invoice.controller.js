import Order from "../../models/Order.js";
import User from "../../models/User.js";
import PDFDocument from "pdfkit";
import { renderTaxInvoice } from "../../utils/invoicePdf.js";

/* USER/ADMIN - DOWNLOAD INVOICE */
export const downloadInvoice = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    const isOwner = String(order.userId) === String(req.user?.userId);
    if (!isOwner) {
      // Not the customer themselves: re-check admin access fresh from the DB
      // (not the JWT's baked-in roles) and require actual orders:read/write,
      // matching requirePermission's behavior so revocation takes effect
      // immediately and access is scoped to the orders module specifically.
      const adminUser = await User.findById(req.user?.userId).select(
        "roles adminRole permissions blocked"
      );
      const roles = Array.isArray(adminUser?.roles) ? adminUser.roles : [];
      const granted = adminUser?.permissions?.get
        ? adminUser.permissions.get("orders")
        : adminUser?.permissions?.["orders"];
      const isAuthorizedAdmin =
        adminUser &&
        !adminUser.blocked &&
        roles.includes("admin") &&
        (adminUser.adminRole === "super_admin" || granted === "read" || granted === "write");

      if (!isAuthorizedAdmin) {
        return res.status(403).json({ message: "Unauthorized" });
      }
    }

    const Settings = (await import("../../models/Settings.js")).default;
    const settings = (await Settings.findOne().lean()) || {};
    const invoiceNo = order.invoiceNumber || order.orderId || String(order._id);
    const safeFilename = String(invoiceNo).replace(/[^a-zA-Z0-9_-]/g, "-");

    const doc = new PDFDocument({
      margin: 0,
      size: "A4",
      bufferPages: true,
      info: {
        Title: `Tax Invoice ${invoiceNo}`,
        Author: settings.storeName || "VKart",
        Subject: `Invoice and payment record for order ${order.orderId || order._id}`,
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=invoice-${safeFilename}.pdf`);
    doc.pipe(res);
    renderTaxInvoice({ doc, order, settings });
    doc.end();
  } catch (err) {
    console.error("Invoice error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
