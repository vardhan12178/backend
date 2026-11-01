import mongoose from 'mongoose';

const { Schema } = mongoose;

// "Tell me when this gets cheaper / comes back" requests. One document per user, variant and kind;
// it is removed once the notification has been sent.
const productAlertSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'CatalogProduct', required: true },
    sku: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['price', 'stock'], required: true },
    // Price when the alert was set: a price alert fires when the price goes below it
    basePrice: { type: Number, min: 0 },
    slug: { type: String, required: true },
    title: { type: String, required: true },
    label: { type: String, default: '' }, // e.g. "256GB · Black"
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

productAlertSchema.index({ userId: 1, sku: 1, kind: 1 }, { unique: true });
productAlertSchema.index({ productId: 1, sku: 1 });

export default mongoose.models.ProductAlert || mongoose.model('ProductAlert', productAlertSchema, 'product_alerts');
