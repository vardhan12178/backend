import mongoose from 'mongoose';

const { Schema } = mongoose;

// One document per Indian PIN code, built from India Post's All India Pincode Directory
// (data.gov.in) by scripts/pincodes/import.js. Used for delivery estimates on product pages.
const pincodeSchema = new Schema(
  {
    _id: { type: String, match: /^[1-9][0-9]{5}$/ }, // the 6-digit PIN code
    area: { type: String, trim: true },              // main post office name, e.g. "Indiranagar"
    district: { type: String, trim: true },
    state: { type: String, trim: true },
    delivery: { type: Boolean, default: true },      // at least one office here delivers mail
    location: { lat: Number, lng: Number },          // average of the offices' coordinates, when published
  },
  { versionKey: false, timestamps: { createdAt: false, updatedAt: true } }
);

export default mongoose.models.Pincode || mongoose.model('Pincode', pincodeSchema, 'pincodes');
