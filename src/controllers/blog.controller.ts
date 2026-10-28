import { NextFunction, Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import Blog from "../models/Blog";
import logger from "../config/logger";

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dxx54fccl",
  api_key: process.env.CLOUDINARY_API_KEY || "149937643231624",
  api_secret: process.env.CLOUDINARY_API_SECRET || "whOZPJleA7xJeu_R8kckqq3Lprc"
});

/**
 * Upload a blog image (cover or gallery) to Cloudinary
 * POST /api/blog/upload-image
 */
export const uploadBlogImage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      res.status(400).json({ success: false, message: "No image provided" });
      return;
    }

    const result = await cloudinary.uploader.upload(imageBase64, {
      folder: "tropica_blog",
      resource_type: "image",
      transformation: [
        { width: 1200, crop: "limit" },
        { quality: "auto:good" },
        { fetch_format: "auto" }
      ]
    });

    res.status(200).json({
      success: true,
      url: result.secure_url,
      publicId: result.public_id
    });
  } catch (error: any) {
    logger.error("Blog image upload error:", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Failed to upload image",
      error: error.message
    });
  }
};

/**
 * Create a new blog post
 * POST /api/admin/blog
 */
export const createBlog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, description, content, coverImage, images, author, tags, isPublished } = req.body;

    if (!title || !description || !content || !coverImage) {
      res.status(400).json({
        success: false,
        message: "Title, description, content, and cover image are required"
      });
      return;
    }

    const blog = new Blog({
      title,
      description,
      content,
      coverImage,
      images: images || [],
      author: author || "Tropica",
      tags: tags || [],
      isPublished: isPublished || false
    });

    await blog.save();

    logger.info(`Blog post created: ${blog.title} (${blog.slug})`);
    res.status(201).json({ success: true, blog });
  } catch (error: any) {
    logger.error("Create blog error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to create blog post", error: error.message });
  }
};

/**
 * Get all blog posts (admin - includes drafts)
 * GET /api/admin/blog
 */
export const getAllBlogsAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, blogs });
  } catch (error: any) {
    logger.error("Get all blogs admin error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to fetch blog posts" });
  }
};

/**
 * Get a single blog post by ID (admin)
 * GET /api/admin/blog/:id
 */
export const getBlogByIdAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      res.status(404).json({ success: false, message: "Blog post not found" });
      return;
    }
    res.status(200).json({ success: true, blog });
  } catch (error: any) {
    logger.error("Get blog by ID admin error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to fetch blog post" });
  }
};

/**
 * Update a blog post
 * PATCH /api/admin/blog/:id
 */
export const updateBlog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, description, content, coverImage, images, author, tags, isPublished } = req.body;
    const blog = await Blog.findById(req.params.id);

    if (!blog) {
      res.status(404).json({ success: false, message: "Blog post not found" });
      return;
    }

    if (title !== undefined) blog.title = title;
    if (description !== undefined) blog.description = description;
    if (content !== undefined) blog.content = content;
    if (coverImage !== undefined) blog.coverImage = coverImage;
    if (images !== undefined) blog.images = images;
    if (author !== undefined) blog.author = author;
    if (tags !== undefined) blog.tags = tags;
    if (isPublished !== undefined) {
      blog.isPublished = isPublished;
      if (isPublished && !blog.publishedAt) {
        blog.publishedAt = new Date();
      }
    }

    await blog.save();

    logger.info(`Blog post updated: ${blog.title} (${blog.slug})`);
    res.status(200).json({ success: true, blog });
  } catch (error: any) {
    logger.error("Update blog error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to update blog post", error: error.message });
  }
};

/**
 * Delete a blog post
 * DELETE /api/admin/blog/:id
 */
export const deleteBlog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) {
      res.status(404).json({ success: false, message: "Blog post not found" });
      return;
    }

    logger.info(`Blog post deleted: ${blog.title}`);
    res.status(200).json({ success: true, message: "Blog post deleted successfully" });
  } catch (error: any) {
    logger.error("Delete blog error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to delete blog post" });
  }
};

/**
 * Get all published blog posts (public)
 * GET /api/blog
 */
export const getPublishedBlogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 12;
    const skip = (page - 1) * limit;

    const [blogs, total] = await Promise.all([
      Blog.find({ isPublished: true })
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-content"),
      Blog.countDocuments({ isPublished: true })
    ]);

    res.status(200).json({
      success: true,
      blogs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error: any) {
    logger.error("Get published blogs error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to fetch blog posts" });
  }
};

/**
 * Get a single published blog post by slug (public)
 * GET /api/blog/:slug
 */
export const getBlogBySlug = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const blog = await Blog.findOne({ slug: req.params.slug, isPublished: true });
    if (!blog) {
      res.status(404).json({ success: false, message: "Blog post not found" });
      return;
    }
    res.status(200).json({ success: true, blog });
  } catch (error: any) {
    logger.error("Get blog by slug error:", { error: error.message });
    res.status(500).json({ success: false, message: "Failed to fetch blog post" });
  }
};
