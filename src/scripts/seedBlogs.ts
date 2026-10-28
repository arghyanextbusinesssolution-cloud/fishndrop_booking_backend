import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../config/db";
import Blog from "../models/Blog";

dotenv.config();

const sampleBlogs = [
  {
    title: "The Art of Botanical Dining in New York City",
    description: "Step inside Tropica's hidden greenhouse conservatory, where lush living flora, ambient candlelight, and Michelin-inspired culinary artistry create an unforgettable evening.",
    content: `## A Hidden Haven in the Concrete City

In a city that never stops moving, finding true intimacy is a rare luxury. Tropica was designed as an oasis—an immersive botanical glasshouse sanctuary where time slows down the moment you step through our doors.

### Flora That Breathes Life Into Every Table

Surrounded by over 150 varieties of rare tropical palms, ferns, and orchid blooms, each private dining alcove offers an undisturbed world. The gentle murmur of indoor waterfalls and soft jazz set the stage for an extraordinary culinary journey.

> "Dining is not merely sustenance; it is an emotional architecture. In our sanctuary, every shadow, scent, and note of flavor is deliberate."

### Farm-to-Table Seasonal Mastery

Our culinary team collaborates closely with local organic farms in upstate New York and sustainable seafood purveyors. Every dish on our seasonal tasting menu highlights pure, unadulterated flavor profiles.`,
    coverImage: "/venue_ambience.jpg",
    images: [
      "/resturant_img1.png",
      "https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=1200&q=80"
    ],
    author: "Executive Chef & Founder",
    tags: ["Sanctuary", "Dining", "Botanical", "Luxury"],
    isPublished: true
  },
  {
    title: "Behind the Glass: Crafting Bespoke Botanical Elixirs",
    description: "Discover how our mixology team infuses cold-smoked botanicals, wild-foraged herbs, and artisanal spirits into award-winning signature cocktails.",
    content: `## The Alchemy of Modern Mixology

At Tropica, our cocktail program is an extension of the garden itself. We believe a cocktail should tell a story—from the first aromatic breath of cold citrus smoke to the complex, lingering finish.

### House-Made Cordials & Wild Botanicals

Every syrup and bitters at Tropica is crafted in-house. We cold-press heirloom fruits, steep rare teas, and extract essential oils from organic herbs grown right within our conservatory.

- **The Smoked Hibiscus Elixir:** Mezcal rested in French oak, spiced agave, freshly steeped hibiscus, and charred rosemary.
- **Midnight Orchid Old Fashioned:** Japanese whiskey, delicate orchid nectar, and bitter orange peel.

### Pairing Cocktails with Multi-Course Dining

Unlike conventional wine pairings, botanical cocktails offer surprising harmonies with savory textures—balancing rich wagyu, refreshing diver scallops, and decadent cocoa ganache.`,
    coverImage: "https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&w=1200&q=80",
    images: [
      "https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=1200&q=80"
    ],
    author: "Head Sommelier",
    tags: ["Cocktails", "Mixology", "Spirits", "Nightlife"],
    isPublished: true
  },
  {
    title: "Planning Milestone Celebrations: Proposals, Anniversaries & Buyouts",
    description: "Whether you're preparing a secret marriage proposal or reserving the full venue for an intimate wedding reception, here is your guide to effortless elegance.",
    content: `## When Moments Demand Uncompromising Perfection

Certain evenings in life deserve more than a standard restaurant reservation. When you celebrate a milestone at Tropica, our dedicated concierge team orchestrates every element to your exact preference.

### Tailored Ambience

- **Bespoke Floral Arches:** Designed by master florists to complement our lush greenery.
- **Acoustic & Musical Curation:** Private violinists, acoustic jazz guitarists, or custom playlists.
- **Custom Commemorative Menus:** Gold-foiled personalized menus with your dates and dedications.

### Full Sanctuary Buyouts

For guests seeking absolute privacy, our full conservatory accommodates up to 60 seated guests or 100 cocktail reception guests. Experience exclusive access to our chef, sommelier, and botanical garden spaces for an entire evening.`,
    coverImage: "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80",
    images: [
      "https://images.unsplash.com/photo-1527529482837-4698179dc6ce?auto=format&fit=crop&w=1200&q=80"
    ],
    author: "Events Director",
    tags: ["Private Events", "Proposals", "Weddings", "Buyouts"],
    isPublished: true
  }
];

const seed = async () => {
  try {
    await connectDB();
    const existingCount = await Blog.countDocuments();
    if (existingCount > 0) {
      console.log(`Database already has ${existingCount} blogs. Skipping seed.`);
      process.exit(0);
    }

    console.log("Seeding sample blogs...");
    for (const item of sampleBlogs) {
      const blog = new Blog(item);
      await blog.save();
      console.log(`Created: ${blog.title} (${blog.slug})`);
    }

    console.log("Blog seeding complete!");
    process.exit(0);
  } catch (err) {
    console.error("Failed to seed blogs:", err);
    process.exit(1);
  }
};

seed();
