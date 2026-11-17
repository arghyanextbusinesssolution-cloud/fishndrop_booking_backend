/**
 * Partner restaurant catering menus for the AI assistant.
 * GENERATED from frontend/lib/cateringRestaurants.ts — when a menu changes there, regenerate this file
 * (same data the booking page shows). Prices are not listed: catering is quoted separately.
 */

export interface AiMenuItem { name: string; desc: string; spicy?: boolean; vegetarian?: boolean }
export interface AiMenuCategory { categoryName: string; items: AiMenuItem[] }
export interface AiCateringRestaurant {
  id: string; name: string; cuisine: string; tagline: string; shortDesc: string; fullDesc: string;
  phoneNumber: string; websiteUrl: string; highlightDishes: string[]; categories: AiMenuCategory[];
}

export const CATERING_MENUS: AiCateringRestaurant[] = [
  {
    "id": "jamaican_jerk_house",
    "name": "Jamaican Jerk House",
    "cuisine": "Jamaican & Caribbean Catering",
    "tagline": "Authentic Caribbean Jerk & Island Soul Flavors",
    "shortDesc": "Authentic Jamaican Jerk chicken, braised oxtail, curry goat, sweet plantains, rice & peas, and Jamaican festival.",
    "fullDesc": "Jamaican Jerk House delivers true island culinary tradition directly to your private gathering. Marinated in authentic scotch bonnet peppers, pimento, thyme, and island spices, every platter is slow-smoked and bursting with flavor.",
    "phoneNumber": "718-235-2023",
    "websiteUrl": "https://www.doordash.com/search/store/Jamaican%20Jerk%20House/",
    "highlightDishes": [
      "Signature Jerk Chicken",
      "Braised Beef Oxtail",
      "Curry Goat",
      "Fried Sweet Plantains",
      "Authentic Rice & Peas"
    ],
    "categories": [
      {
        "categoryName": "Signature Island Entrees",
        "items": [
          {
            "name": "Authentic Jerk Chicken",
            "desc": "Slow-smoked chicken marinated in our house scotch bonnet, scallion, and pimento island rub.",
            "spicy": true
          },
          {
            "name": "Braised Beef Oxtail & Butter Beans",
            "desc": "Tender, fall-off-the-bone beef oxtails simmered in rich Jamaican brown stew with butter beans."
          },
          {
            "name": "Traditional Curry Goat",
            "desc": "Slow-braised goat cooked in authentic Jamaican turmeric curry and herbs until melt-in-mouth tender.",
            "spicy": true
          },
          {
            "name": "Escovitch Snapper / King Fish",
            "desc": "Pan-fried whole fish topped with spicy pickled carrots, scotch bonnet peppers, and sweet bell peppers."
          },
          {
            "name": "Brown Stew Chicken",
            "desc": "Caramelized chicken thighs simmered low and slow in aromatic island gravy with sweet peppers."
          }
        ]
      },
      {
        "categoryName": "Traditional Island Sides",
        "items": [
          {
            "name": "Coconut Rice & Red Peas",
            "desc": "Jasmine rice simmered in fresh coconut milk, thyme, scallions, and red kidney beans.",
            "vegetarian": true
          },
          {
            "name": "Caramelized Sweet Plantains",
            "desc": "Ripe golden plantains pan-fried sweet and soft.",
            "vegetarian": true
          },
          {
            "name": "Jamaican Fried Festival",
            "desc": "Sweet, crispy fried cornmeal dough dumplings.",
            "vegetarian": true
          },
          {
            "name": "Steamed Island Cabbage & Veggies",
            "desc": "Lightly sauteed cabbage with shredded carrots, bell peppers, and fresh thyme.",
            "vegetarian": true
          },
          {
            "name": "Caribbean Baked Macaroni & Cheese Pie",
            "desc": "Rich 4-cheese baked macaroni pie seasoned with island spices.",
            "vegetarian": true
          }
        ]
      },
      {
        "categoryName": "Tropical Beverages",
        "items": [
          {
            "name": "Homemade Sorrel (Hibiscus & Ginger)",
            "desc": "Fresh hibiscus flower brew infused with Jamaican ginger and cloves."
          },
          {
            "name": "Jamaican D&G Ginger Beer & Ting",
            "desc": "Crisp sparkling Caribbean sodas."
          }
        ]
      }
    ]
  },
  {
    "id": "east_coast_street_tacos",
    "name": "East Coast Street Tacos",
    "cuisine": "Authentic Mexican Street Food & Fiesta Catering",
    "tagline": "Authentic Handcrafted Mexican Street Tacos & Birria",
    "shortDesc": "Fresh handcrafted tacos, slow-cooked birria with consomé, carne asada, al pastor, fresh guacamole, loaded nachos, and churros.",
    "fullDesc": "East Coast Street Tacos brings the authentic flavors of Mexico's street taquerias with housemade corn tortillas, prime meats, vibrant salsas, and rich birria broth.",
    "phoneNumber": "+1 (347) 702-9485",
    "websiteUrl": "https://eastcoaststreettacos.com",
    "highlightDishes": [
      "Birria Tacos with Consomé",
      "Carne Asada Tacos",
      "Al Pastor with Pineapple",
      "Loaded Fiesta Nachos",
      "Churros with Dulce de Leche"
    ],
    "categories": [
      {
        "categoryName": "Signature Street Tacos",
        "items": [
          {
            "name": "Birria Tacos con Consomé",
            "desc": "Slow-braised beef brisket crisped in chili oil with Oaxaca cheese, cilantro, onions & rich dipping broth."
          },
          {
            "name": "Carne Asada Tacos",
            "desc": "Citrus and garlic marinated prime steak char-grilled over open flame with fresh cilantro and onions."
          },
          {
            "name": "Al Pastor Tacos",
            "desc": "Pork loin marinated in achiote and guajillo chili, roasted with sweet grilled pineapple chunks."
          },
          {
            "name": "Pollo Asado Tacos",
            "desc": "Flame-grilled chicken breast with house cilantro-lime marinade, pico de gallo, and salsa verde."
          },
          {
            "name": "Baja Style Crispy Fish / Shrimp Tacos",
            "desc": "Beer-battered fish or grilled shrimp topped with crunchy red cabbage slaw and chipotle crema."
          }
        ]
      },
      {
        "categoryName": "Fiesta Platters & Street Sides",
        "items": [
          {
            "name": "Loaded Fiesta Nachos",
            "desc": "Warm house tortilla chips piled high with warm queso, black beans, pico, jalapeños, guacamole & crema.",
            "vegetarian": true
          },
          {
            "name": "Fresh Hand-Smashed Guacamole & Chips",
            "desc": "Ripe Hass avocados mashed with lime juice, sea salt, diced onions, cilantro & serrano peppers.",
            "vegetarian": true
          },
          {
            "name": "Mexican Street Corn (Elote)",
            "desc": "Charred sweet corn on the cob slathered in Mexican crema, cotija cheese, chili powder & fresh lime.",
            "vegetarian": true
          },
          {
            "name": "Cheese & Protein Quesadillas",
            "desc": "Giant grilled flour tortillas packed with melted Oaxaca and Chihuahua cheeses."
          }
        ]
      },
      {
        "categoryName": "Mexican Desserts & Aguas Frescas",
        "items": [
          {
            "name": "Cinnamon Sugar Churros",
            "desc": "Warm crispy fried dough tossed in cinnamon sugar, served with warm dulce de leche."
          },
          {
            "name": "Housemade Horchata & Jamaica",
            "desc": "Traditional cinnamon rice milk and chilled hibiscus tea."
          }
        ]
      }
    ]
  },
  {
    "id": "cooklyn_eats",
    "name": "Cooklyn Eats",
    "cuisine": "Southern Soul Food & Comfort Catering",
    "tagline": "Modern Soul Food & Southern Comfort Elevated",
    "shortDesc": "Golden crispy Southern fried chicken, smoked St. Louis BBQ ribs, 5-cheese baked mac & cheese, slow-braised collard greens, and sweet potato cornbread.",
    "fullDesc": "Cooklyn Eats brings hearty, soulful Southern recipes crafted with premium cuts, homemade marinades, and generational comfort food recipes that elevate any celebration.",
    "phoneNumber": "+1 (718) 535-6255",
    "websiteUrl": "https://www.cooklyneats.com/",
    "highlightDishes": [
      "Southern Fried Chicken",
      "Smoked BBQ Ribs",
      "5-Cheese Baked Mac & Cheese",
      "Slow-Cooked Collard Greens",
      "Honey Cornbread"
    ],
    "categories": [
      {
        "categoryName": "Soul Food Classics & Mains",
        "items": [
          {
            "name": "Golden Southern Fried Chicken",
            "desc": "24-hour buttermilk brined chicken seasoned with secret Southern herbs and fried extra crispy."
          },
          {
            "name": "Smoked St. Louis BBQ Ribs",
            "desc": "Hickory-smoked fall-off-the-bone pork ribs basted in chef's sweet and tangy bourbon BBQ glaze."
          },
          {
            "name": "Blackened Salmon & Creamy Grits",
            "desc": "Pan-seared Atlantic salmon coated in Cajun blackened spices over stone-ground cheddar grits."
          },
          {
            "name": "Crispy Cornmeal Catfish Fillets",
            "desc": "Golden fried catfish fillets served with house spicy Cajun remoulade sauce and lemon wedges."
          },
          {
            "name": "Smothered Pork Chops",
            "desc": "Tender seasoned pork chops smothered in rich, slow-simmered caramelized onion and herb gravy."
          }
        ]
      },
      {
        "categoryName": "Iconic Southern Comfort Sides",
        "items": [
          {
            "name": "5-Cheese Baked Macaroni & Cheese",
            "desc": "Cavatappi pasta loaded with sharp cheddar, smoked gouda, gruyere, Monterey Jack, and parmesan.",
            "vegetarian": true
          },
          {
            "name": "Slow-Braised Collard Greens",
            "desc": "Fresh collard greens simmered low and slow with smoked turkey aromatics, garlic, and cider vinegar."
          },
          {
            "name": "Candied Sweet Yams",
            "desc": "Sliced sweet potatoes baked in brown sugar, pure vanilla, nutmeg, cinnamon, and golden butter glaze.",
            "vegetarian": true
          },
          {
            "name": "Warm Golden Honey Cornbread",
            "desc": "Freshly baked sweet Southern cornbread brushed with wildflower honey butter.",
            "vegetarian": true
          }
        ]
      },
      {
        "categoryName": "Southern Desserts & Sips",
        "items": [
          {
            "name": "Homestyle Peach Cobbler",
            "desc": "Spiced sweet Georgia peaches baked beneath a buttery golden flaky crust."
          },
          {
            "name": "Southern Sweet Tea & Fresh Lemonade",
            "desc": "Traditional sweet brewed black tea and fresh squeezed lemon Arnold Palmers."
          }
        ]
      }
    ]
  },
  {
    "id": "custom_catering",
    "name": "Custom / Multi-Restaurant Mix",
    "cuisine": "Multi-Partner Culinary Experience",
    "tagline": "Bespoke Dining Vision or Dietary Requirements",
    "shortDesc": "Tailored multi-course catering blending specialties across our partner kitchens or your personal culinary vision.",
    "fullDesc": "Work directly with our event concierges to curate a bespoke menu featuring dishes from Jamaican Jerk House, East Coast Street Tacos, Cooklyn Eats, or external licensed caterers.",
    "phoneNumber": "",
    "websiteUrl": "",
    "highlightDishes": [],
    "categories": []
  }
];
