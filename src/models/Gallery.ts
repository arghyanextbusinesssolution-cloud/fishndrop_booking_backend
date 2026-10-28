import mongoose, { Document, Schema } from "mongoose";

export interface IGalleryItem extends Document {
  user?: mongoose.Types.ObjectId;
  userName: string;
  userEmail?: string;
  userPhone?: string;
  title: string;
  description?: string;
  imageUrl: string;
  category: "all" | "garden" | "dining" | "culinary" | "cocktails" | "events" | "guest_memories";
  status: "pending" | "approved" | "rejected";
  isPublished: boolean;
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const gallerySchema = new Schema<IGalleryItem>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false
    },
    userName: {
      type: String,
      required: [true, "Submitter name is required"],
      trim: true,
      maxlength: 100
    },
    userEmail: {
      type: String,
      trim: true,
      lowercase: true
    },
    userPhone: {
      type: String,
      trim: true
    },
    title: {
      type: String,
      required: [true, "Photo title or caption is required"],
      trim: true,
      maxlength: 150
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    },
    imageUrl: {
      type: String,
      required: [true, "Image URL is required"]
    },
    category: {
      type: String,
      enum: ["all", "garden", "dining", "culinary", "cocktails", "events", "guest_memories"],
      default: "guest_memories"
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending"
    },
    isPublished: {
      type: Boolean,
      default: false
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User"
    },
    approvedAt: {
      type: Date
    },
    rejectionReason: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

gallerySchema.index({ isPublished: 1, createdAt: -1 });
gallerySchema.index({ status: 1 });
gallerySchema.index({ user: 1 });

const Gallery = mongoose.model<IGalleryItem>("Gallery", gallerySchema);
export default Gallery;
