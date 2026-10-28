import mongoose, { Document, Schema } from "mongoose";

export interface IBlog extends Document {
  title: string;
  slug: string;
  description: string;
  content: string;
  coverImage: string;
  images: string[];
  author: string;
  tags: string[];
  isPublished: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const blogSchema = new Schema<IBlog>(
  {
    title: {
      type: String,
      required: [true, "Blog title is required"],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"]
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true
    },
    description: {
      type: String,
      required: [true, "Blog description is required"],
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"]
    },
    content: {
      type: String,
      required: [true, "Blog content is required"]
    },
    coverImage: {
      type: String,
      required: [true, "Cover image is required"]
    },
    images: {
      type: [String],
      default: []
    },
    author: {
      type: String,
      default: "Tropica"
    },
    tags: {
      type: [String],
      default: []
    },
    isPublished: {
      type: Boolean,
      default: false
    },
    publishedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Generate slug from title before saving
blogSchema.pre("save", async function () {
  if (this.isModified("title") || !this.slug) {
    const baseSlug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim();
    // Append a short random suffix to avoid collisions
    this.slug = `${baseSlug}-${Date.now().toString(36)}`;
  }
  if (this.isPublished && !this.publishedAt) {
    this.publishedAt = new Date();
  }
});

blogSchema.index({ isPublished: 1, publishedAt: -1 });
blogSchema.index({ tags: 1 });

const Blog = mongoose.model<IBlog>("Blog", blogSchema);
export default Blog;
